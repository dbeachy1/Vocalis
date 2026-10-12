using System;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

namespace VocalisSatelliteTray
{
    // The one channel to the running icon, for both "--exit" and "--do": a named pipe that only the current user can
    // open. One request line in ("exit" or "do <verb>"), one reply line out ("ok", "ok: <text>" or "error: <reason>").
    internal sealed class ControlServer : IDisposable
    {
        private readonly string pipeName;
        private readonly Func<string, string> handler;
        private readonly ILog log;
        private readonly ManualResetEvent stop = new ManualResetEvent(false);
        private Thread thread;

        public ControlServer(string pipeName, Func<string, string> handler, ILog log)
        {
            this.pipeName = pipeName;
            this.handler = handler;
            this.log = log;
        }

        public void Start()
        {
            thread = new Thread(Loop) { IsBackground = true, Name = "satellite tray control pipe" };
            thread.Start();
            log.Write("control pipe: listening on " + pipeName);
        }

        public void Dispose()
        {
            stop.Set();
            if (thread != null && thread != Thread.CurrentThread)
            {
                if (!thread.Join(3000)) log.Write("control pipe: the listener thread did not end within 3 s");
            }
            log.Write("control pipe: stopped");
        }

        private NamedPipeServerStream Create()
        {
            var security = new PipeSecurity();
            security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
            return new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous, 4096, 4096, security);
        }

        private void Loop()
        {
            while (!stop.WaitOne(0))
            {
                NamedPipeServerStream pipe = null;
                try
                {
                    pipe = Create();
                    IAsyncResult waiting = pipe.BeginWaitForConnection(null, null);
                    if (WaitHandle.WaitAny(new[] { waiting.AsyncWaitHandle, stop }) == 1) break;
                    pipe.EndWaitForConnection(waiting);
                    Serve(pipe);
                }
                catch (IOException ex)
                {
                    log.Write("control pipe: " + ex.Message);
                    stop.WaitOne(500);
                }
                catch (UnauthorizedAccessException ex)
                {
                    log.Write("control pipe: could not create the pipe: " + ex.Message);
                    stop.WaitOne(1000);
                }
                finally
                {
                    if (pipe != null) pipe.Dispose();
                }
            }
        }

        private void Serve(NamedPipeServerStream pipe)
        {
            var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 1024, true);
            string request;
            try
            {
                var reading = reader.ReadLineAsync();
                if (!reading.Wait(5000))
                {
                    log.Write("control pipe: a client connected and sent no request within 5 s; dropped");
                    return;
                }
                request = reading.Result;
            }
            catch (AggregateException ex)
            {
                log.Write("control pipe: reading the request failed: " + ex.GetBaseException().Message);
                return;
            }
            if (request != null && request.Length > 256) request = request.Substring(0, 256);
            var watch = System.Diagnostics.Stopwatch.StartNew();
            string response;
            try
            {
                response = handler(request);
            }
            catch (Exception ex)
            {
                // A fault in a command must come back to the caller as a reply, never end the listener.
                log.Write("control pipe: the handler failed for \"" + request + "\": " + ex);
                response = "error: the icon failed to run the command: " + ex.Message;
            }
            log.Write("control pipe: request \"" + request + "\" -> \"" + response + "\" in " + watch.ElapsedMilliseconds + " ms");
            try
            {
                byte[] bytes = new UTF8Encoding(false).GetBytes((response ?? "error: no reply").Replace("\r", " ").Replace("\n", " ") + "\n");
                pipe.Write(bytes, 0, bytes.Length);
                pipe.Flush();
                pipe.WaitForPipeDrain();
            }
            catch (IOException ex)
            {
                log.Write("control pipe: the client went away before the reply was written: " + ex.Message);
            }
        }
    }

    internal enum ChannelOutcome
    {
        Replied,
        NotRunning,
        NoReply
    }

    internal sealed class ChannelResult
    {
        public ChannelOutcome Outcome;
        public string Reply;
        public string Detail;
    }

    internal static class ControlClient
    {
        public static ChannelResult Send(string pipeName, string request, int connectMs, int replyMs)
        {
            using (var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous))
            {
                try
                {
                    pipe.Connect(connectMs);
                }
                catch (TimeoutException)
                {
                    return new ChannelResult { Outcome = ChannelOutcome.NotRunning, Detail = "no icon answered on the control pipe within " + connectMs + " ms" };
                }
                catch (IOException ex)
                {
                    return new ChannelResult { Outcome = ChannelOutcome.NotRunning, Detail = ex.Message };
                }
                try
                {
                    byte[] bytes = new UTF8Encoding(false).GetBytes(request + "\n");
                    pipe.Write(bytes, 0, bytes.Length);
                    pipe.Flush();
                    var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 1024, true);
                    var reading = reader.ReadLineAsync();
                    if (!reading.Wait(replyMs))
                        return new ChannelResult { Outcome = ChannelOutcome.NoReply, Detail = "the icon did not answer within " + (replyMs / 1000) + " seconds" };
                    if (reading.Result == null)
                        return new ChannelResult { Outcome = ChannelOutcome.NoReply, Detail = "the icon closed the connection without an answer" };
                    return new ChannelResult { Outcome = ChannelOutcome.Replied, Reply = reading.Result };
                }
                catch (IOException ex)
                {
                    return new ChannelResult { Outcome = ChannelOutcome.NoReply, Detail = ex.Message };
                }
                catch (AggregateException ex)
                {
                    return new ChannelResult { Outcome = ChannelOutcome.NoReply, Detail = ex.GetBaseException().Message };
                }
            }
        }
    }

    // What the running icon does with a request line. The icon's window code only supplies "close yourself".
    internal sealed class ControlRequestHandler
    {
        private readonly SatelliteController controller;
        private readonly Action requestExit;
        private readonly ILog log;

        public ControlRequestHandler(SatelliteController controller, Action requestExit, ILog log)
        {
            this.controller = controller;
            this.requestExit = requestExit;
            this.log = log;
        }

        public string Handle(string request)
        {
            request = (request ?? "").Trim();
            if (request == "exit")
            {
                log.Write("control: exit requested");
                requestExit();
                return "ok";
            }
            if (request.StartsWith("do ", StringComparison.Ordinal))
            {
                string verb = request.Substring(3).Trim();
                if (Array.IndexOf(CommandLine.Verbs, verb) < 0) return "error: unknown command \"" + verb + "\"";
                CommandOutcome outcome = controller.Execute(verb);
                return outcome.Ok ? "ok" : "error: " + outcome.Reason;
            }
            log.Write("control: unknown request \"" + request + "\"");
            return "error: unknown request";
        }
    }

    // The two command-line modes that talk to a running icon. Exit codes: 0 done, 1 refused or failed (reason on stderr),
    // 2 bad usage, 3 no icon is running, 4 the icon did not answer in time.
    internal static class ControlCommands
    {
        public const int Done = 0;
        public const int Failed = 1;
        public const int BadUsage = 2;
        public const int NoIcon = 3;
        public const int NoAnswer = 4;

        public static int RunDo(InstanceNames names, string verb, TextWriter stdout, TextWriter stderr, int connectMs, int replyMs)
        {
            Mutex running;
            if (!Mutex.TryOpenExisting(names.Mutex, out running))
            {
                stderr.WriteLine("The Vocalis satellite icon is not running, so \"" + verb + "\" was not done. Start the icon first (Start menu, Vocalis Satellite).");
                return NoIcon;
            }
            running.Dispose();
            ChannelResult result = ControlClient.Send(names.Pipe, "do " + verb, connectMs, replyMs);
            switch (result.Outcome)
            {
                case ChannelOutcome.NotRunning:
                    stderr.WriteLine("The Vocalis satellite icon is not running (" + result.Detail + "), so \"" + verb + "\" was not done.");
                    return NoIcon;
                case ChannelOutcome.NoReply:
                    stderr.WriteLine("The icon did not finish \"" + verb + "\": " + result.Detail + ".");
                    return NoAnswer;
            }
            if (result.Reply == "ok" || result.Reply.StartsWith("ok:", StringComparison.Ordinal))
            {
                stdout.WriteLine(result.Reply);
                return Done;
            }
            stderr.WriteLine(result.Reply.StartsWith("error: ", StringComparison.Ordinal) ? result.Reply.Substring(7) : result.Reply);
            return Failed;
        }

        // --exit: ask the running icon to close, then wait for its mutex. The mutex handle is opened first, so an icon
        // that ends at once cannot be missed. A mutex that comes back abandoned means the icon ended without releasing
        // it, which is a crash (or a kill), and is said as that rather than treated as a clean close.
        public static int RunExit(InstanceNames names, TextWriter stdout, TextWriter stderr, int connectMs, int replyMs, int endMs)
        {
            Mutex running;
            if (!Mutex.TryOpenExisting(names.Mutex, out running))
            {
                stdout.WriteLine("No Vocalis satellite icon is running.");
                return Done;
            }
            using (running)
            {
                var watch = System.Diagnostics.Stopwatch.StartNew();
                ChannelResult result = ControlClient.Send(names.Pipe, "exit", connectMs, replyMs);
                if (result.Outcome != ChannelOutcome.Replied)
                {
                    stderr.WriteLine("The running icon did not accept the request to close: " + result.Detail + ".");
                    return result.Outcome == ChannelOutcome.NotRunning ? Failed : NoAnswer;
                }
                if (result.Reply != "ok")
                {
                    stderr.WriteLine("The running icon refused to close: " + result.Reply + ".");
                    return Failed;
                }
                bool got;
                try
                {
                    got = running.WaitOne(endMs);
                }
                catch (AbandonedMutexException)
                {
                    stderr.WriteLine("The running icon ended by crashing: it did not release its lock when it closed (it was gone after " + watch.ElapsedMilliseconds + " ms).");
                    return Failed;
                }
                if (!got)
                {
                    stderr.WriteLine("The running icon did not end within " + (endMs / 1000) + " seconds.");
                    return NoAnswer;
                }
                running.ReleaseMutex();
                stdout.WriteLine("The icon closed after " + watch.ElapsedMilliseconds + " ms.");
                return Done;
            }
        }
    }
}
