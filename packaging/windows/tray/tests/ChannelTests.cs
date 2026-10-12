using System;
using System.IO;
using System.Threading;
using Xunit;

namespace VocalisSatelliteTray.Tests
{
    public class SingleInstanceTests
    {
        private static string Name()
        {
            return "Local\\VocalisSatelliteTray.Tests." + Guid.NewGuid().ToString("N");
        }

        [Fact]
        public void The_first_copy_gets_the_mutex_and_a_second_one_is_told_to_exit()
        {
            string name = Name();
            using (SingleInstance first = SingleInstance.TryAcquire(name))
            {
                Assert.NotNull(first);
                Assert.Null(SingleInstance.TryAcquire(name));
                Assert.Null(SingleInstance.TryAcquire(name));
            }
        }

        [Fact]
        public void After_the_first_copy_ends_another_can_start()
        {
            string name = Name();
            SingleInstance first = SingleInstance.TryAcquire(name);
            Assert.NotNull(first);
            first.Release();
            first.Dispose();
            using (SingleInstance again = SingleInstance.TryAcquire(name)) Assert.NotNull(again);
        }

        [Fact]
        public void Two_names_do_not_collide()
        {
            using (SingleInstance a = SingleInstance.TryAcquire(Name()))
            using (SingleInstance b = SingleInstance.TryAcquire(Name()))
            {
                Assert.NotNull(a);
                Assert.NotNull(b);
            }
        }
    }

    // A real named pipe and a real mutex, one process: a stand-in "running icon" owns the mutex on its own thread and
    // serves the pipe, so --exit and --do can be driven end to end without a window.
    public class ControlChannelTests : IDisposable
    {
        private readonly InstanceNames names = new InstanceNames
        {
            Mutex = "Local\\VocalisSatelliteTray.Tests." + Guid.NewGuid().ToString("N"),
            Pipe = "VocalisSatelliteTray.Tests." + Guid.NewGuid().ToString("N")
        };
        private readonly ListLog log = new ListLog();
        private ControlServer server;
        private Thread owner;
        private readonly ManualResetEvent releaseMutex = new ManualResetEvent(false);
        private readonly ManualResetEvent ownerDone = new ManualResetEvent(false);

        public void Dispose()
        {
            if (server != null) server.Dispose();
            releaseMutex.Set();
            if (owner != null) owner.Join(5000);
        }

        // The stand-in icon: owns the mutex on one thread, and how it ends is chosen by the test.
        private void StartIcon(Func<string, string> handler, bool endsCleanly)
        {
            var acquired = new ManualResetEvent(false);
            owner = new Thread(() =>
            {
                SingleInstance instance = SingleInstance.TryAcquire(names.Mutex);
                acquired.Set();
                releaseMutex.WaitOne();
                if (endsCleanly) instance.Release();
                // A crash leaves the mutex owned by a thread that ends: it is abandoned.
                ownerDone.Set();
            });
            owner.Start();
            Assert.True(acquired.WaitOne(5000));
            server = new ControlServer(names.Pipe, handler, log);
            server.Start();
        }

        [Fact]
        public void A_request_gets_one_reply_line()
        {
            StartIcon(request => "ok: you said " + request, true);
            ChannelResult r = ControlClient.Send(names.Pipe, "do start", 5000, 5000);
            Assert.Equal(ChannelOutcome.Replied, r.Outcome);
            Assert.Equal("ok: you said do start", r.Reply);
        }

        [Fact]
        public void The_server_takes_many_requests_in_a_row()
        {
            int n = 0;
            StartIcon(request => "ok " + Interlocked.Increment(ref n), true);
            for (int i = 1; i <= 5; i++)
                Assert.Equal("ok " + i, ControlClient.Send(names.Pipe, "x", 5000, 5000).Reply);
        }

        [Fact]
        public void A_handler_that_throws_comes_back_as_an_error_reply_and_the_server_keeps_going()
        {
            StartIcon(request => { if (request == "boom") throw new InvalidOperationException("kaboom"); return "ok"; }, true);
            Assert.StartsWith("error:", ControlClient.Send(names.Pipe, "boom", 5000, 5000).Reply);
            Assert.Equal("ok", ControlClient.Send(names.Pipe, "fine", 5000, 5000).Reply);
            Assert.True(log.Has("kaboom"));
        }

        [Fact]
        public void With_no_server_the_client_says_nothing_is_running()
        {
            ChannelResult r = ControlClient.Send(names.Pipe, "do start", 300, 300);
            Assert.Equal(ChannelOutcome.NotRunning, r.Outcome);
        }

        [Fact]
        public void A_slow_reply_is_cut_off_at_the_clients_bound()
        {
            StartIcon(request => { Thread.Sleep(1500); return "ok"; }, true);
            ChannelResult r = ControlClient.Send(names.Pipe, "do start", 5000, 200);
            Assert.Equal(ChannelOutcome.NoReply, r.Outcome);
        }

        [Fact]
        public void The_handler_maps_requests_to_the_controller_and_exit_to_the_window()
        {
            var h = new Harness();
            h.Controller.Refresh("setup");
            int exits = 0;
            var handler = new ControlRequestHandler(h.Controller, () => exits++, h.Log);
            Assert.Equal("ok", handler.Handle("exit"));
            Assert.Equal(1, exits);
            h.ContainerAnswer = Docker.Exited();
            Assert.Equal("ok", handler.Handle("do start"));
            Assert.Equal(1, h.Runner.Count("docker start"));
            h.StartAnswer = Docker.Refused("nope");
            h.ContainerAnswer = Docker.Exited();
            string reply = handler.Handle("do start");
            Assert.StartsWith("error: Error response from daemon: nope", reply);
            Assert.StartsWith("error:", handler.Handle("do pause"));
            Assert.StartsWith("error:", handler.Handle("rm -rf"));
            Assert.Equal(1, exits);
        }

        [Fact]
        public void Do_with_no_icon_running_exits_3_and_says_so()
        {
            var o = new StringWriter();
            var e = new StringWriter();
            int code = ControlCommands.RunDo(names, "start", o, e, 300, 300);
            Assert.Equal(ControlCommands.NoIcon, code);
            Assert.Contains("not running", e.ToString());
        }

        [Fact]
        public void Do_gives_zero_on_success_and_the_reason_on_stderr_otherwise()
        {
            StartIcon(request => request == "do start" ? "ok" : "error: Docker Desktop is not running", true);
            var o = new StringWriter();
            var e = new StringWriter();
            Assert.Equal(ControlCommands.Done, ControlCommands.RunDo(names, "start", o, e, 5000, 5000));
            Assert.Equal("", e.ToString());
            Assert.Equal(ControlCommands.Failed, ControlCommands.RunDo(names, "stop", o, e, 5000, 5000));
            Assert.Equal("Docker Desktop is not running" + Environment.NewLine, e.ToString());
        }

        [Fact]
        public void Do_gives_4_when_the_icon_does_not_answer_in_time()
        {
            StartIcon(request => { Thread.Sleep(1500); return "ok"; }, true);
            var e = new StringWriter();
            Assert.Equal(ControlCommands.NoAnswer, ControlCommands.RunDo(names, "start", new StringWriter(), e, 5000, 200));
            Assert.Contains("did not finish", e.ToString());
        }

        [Fact]
        public void Exit_with_no_icon_running_is_quietly_zero()
        {
            var o = new StringWriter();
            Assert.Equal(ControlCommands.Done, ControlCommands.RunExit(names, o, new StringWriter(), 300, 300, 300));
            Assert.Contains("No Vocalis satellite icon is running", o.ToString());
        }

        [Fact]
        public void Exit_waits_for_a_clean_close_and_reports_zero()
        {
            StartIcon(request => { releaseMutex.Set(); return "ok"; }, true);
            var o = new StringWriter();
            var e = new StringWriter();
            Assert.Equal(ControlCommands.Done, ControlCommands.RunExit(names, o, e, 5000, 5000, 5000));
            Assert.Equal("", e.ToString());
            Assert.Contains("closed", o.ToString());
        }

        [Fact]
        public void Exit_says_so_when_the_running_copy_ended_by_crashing()
        {
            StartIcon(request => { releaseMutex.Set(); return "ok"; }, false);
            var e = new StringWriter();
            int code = ControlCommands.RunExit(names, new StringWriter(), e, 5000, 5000, 5000);
            Assert.Equal(ControlCommands.Failed, code);
            Assert.Contains("crash", e.ToString());
        }

        [Fact]
        public void Exit_reports_a_copy_that_does_not_end_in_time()
        {
            StartIcon(request => "ok", true); // accepts the request but never lets go of its mutex
            var e = new StringWriter();
            Assert.Equal(ControlCommands.NoAnswer, ControlCommands.RunExit(names, new StringWriter(), e, 5000, 5000, 300));
            Assert.Contains("did not end", e.ToString());
        }
    }
}
