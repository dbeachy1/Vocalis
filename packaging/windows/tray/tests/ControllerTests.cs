using System.Linq;
using Xunit;

namespace VocalisSatelliteTray.Tests
{
    public class RefreshTests
    {
        private const string PlanCall = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"C:\\app\\satellite-setup.ps1\" -Root \"C:\\sat\" -ShowPlan";
        private const string InspectCall = "docker container inspect --format \"{{.State.Status}} {{.State.Restarting}}\" " + Plans.Container;

        [Fact]
        public void The_first_refresh_asks_the_script_for_the_plan_then_docker_for_the_container()
        {
            var h = new Harness();
            TrayState s = h.Controller.Refresh("test");
            Assert.Equal(Situation.Running, s.Situation);
            Assert.Equal(new[] { PlanCall, InspectCall }, h.Runner.Calls.ToArray());
            Assert.Equal(SatelliteScript.PlanTimeoutMs, h.Runner.Timeouts[0]);
        }

        [Fact]
        public void A_second_refresh_only_asks_docker_until_the_state_file_changes()
        {
            var h = new Harness();
            h.Controller.Refresh("one");
            h.Runner.Clear();
            h.Controller.Refresh("two");
            Assert.Equal(new[] { InspectCall }, h.Runner.Calls.ToArray());
            h.Runner.Clear();
            h.StateFile.Version = "2";
            h.Controller.Refresh("three");
            Assert.Equal(new[] { PlanCall, InspectCall }, h.Runner.Calls.ToArray());
        }

        [Fact]
        public void A_state_file_with_no_root_means_no_satellite_and_asks_nobody()
        {
            var h = new Harness();
            h.StateFile.Root = null;
            TrayState s = h.Controller.Refresh("test");
            Assert.Equal(Situation.NoSatellite, s.Situation);
            Assert.Empty(h.Runner.Calls);
        }

        [Fact]
        public void A_plan_of_new_shows_no_satellite_and_asks_docker_nothing()
        {
            var h = new Harness { PlanAnswer = Plans.NewSatellite() };
            Assert.Equal(Situation.NoSatellite, h.Controller.Refresh("test").Situation);
            Assert.Equal(0, h.Runner.Count("docker"));
        }

        [Fact]
        public void An_unreadable_folder_is_asked_again_each_time_and_recovers_when_it_can_be_read()
        {
            var h = new Harness { PlanAnswer = Plans.Refused("The folder is not there.") };
            TrayState s = h.Controller.Refresh("one");
            Assert.Equal(Situation.FolderUnreadable, s.Situation);
            Assert.Contains("The folder is not there.", s.MenuLine);
            Assert.Equal(0, h.Runner.Count("docker"));
            h.Controller.Refresh("two");
            Assert.Equal(2, h.Runner.Count("-ShowPlan"));
            h.PlanAnswer = Plans.Existing();
            Assert.Equal(Situation.Running, h.Controller.Refresh("three").Situation);
        }

        [Theory]
        [InlineData("running", "Running")]
        [InlineData("exited", "Stopped")]
        [InlineData("restarting", "Starting")]
        public void Each_container_answer_gives_its_situation(string which, string expected)
        {
            var h = new Harness();
            h.ContainerAnswer = which == "running" ? Docker.Running() : which == "exited" ? Docker.Exited() : Docker.Restarting();
            Assert.Equal(expected, h.Controller.Refresh("test").Situation.ToString());
        }

        [Fact]
        public void A_missing_container_and_a_docker_that_does_not_answer_are_told_apart_and_it_follows_docker_coming_up()
        {
            var h = new Harness { ContainerAnswer = Docker.Down() };
            Assert.Equal(Situation.DockerNotRunning, h.Controller.Refresh("one").Situation);
            h.ContainerAnswer = Docker.Missing();
            Assert.Equal(Situation.ContainerMissing, h.Controller.Refresh("two").Situation);
            h.ContainerAnswer = Docker.Running();
            Assert.Equal(Situation.Running, h.Controller.Refresh("three").Situation);
        }

        [Fact]
        public void Docker_desktops_sign_in_setting_is_read_at_each_refresh()
        {
            var h = new Harness { ContainerAnswer = Docker.Down(), DockerDesktopAtSignIn = false };
            Assert.Contains("is not set to start when you sign in", h.Controller.Refresh("one").MenuLine);
            h.DockerDesktopAtSignIn = true;
            Assert.DoesNotContain("is not set to start", h.Controller.Refresh("two").MenuLine);
        }

        [Fact]
        public void The_window_is_told_about_each_refresh_and_the_decision_is_logged_with_values()
        {
            var h = new Harness();
            h.Controller.Refresh("test");
            Assert.Single(h.Notified);
            Assert.True(h.Log.Has("plan: root=C:\\sat exit=0 kind=Existing container=" + Plans.Container + " port=7880 autostart=on name=workstation"));
            Assert.True(h.Log.Has("state: Checking -> Running"));
        }
    }

    public class CommandTests
    {
        private static readonly string StartCall = "docker start " + Plans.Container;
        private static readonly string StopCall = "docker stop " + Plans.Container;

        private static Harness Ready(ProcessResult container)
        {
            var h = new Harness(false, container);
            h.Controller.Refresh("setup");
            h.Runner.Clear();
            return h;
        }

        [Fact]
        public void Start_issues_docker_start_then_looks_at_docker_again_and_shows_running()
        {
            Harness h = Ready(Docker.Exited());
            CommandOutcome o = h.Controller.Start();
            Assert.True(o.Ok);
            Assert.Equal(2, h.Runner.Calls.Count);
            Assert.Equal(StartCall, h.Runner.Calls[0]);
            Assert.Contains("container inspect", h.Runner.Calls[1]);
            Assert.Equal(Situation.Running, h.Controller.State.Situation);
            Assert.Equal("Running on port 7880", h.Controller.State.MenuLine);
        }

        [Fact]
        public void Stop_issues_docker_stop_then_looks_at_docker_again_and_shows_stopped()
        {
            Harness h = Ready(Docker.Running());
            Assert.True(h.Controller.Stop().Ok);
            Assert.Equal(StopCall, h.Runner.Calls[0]);
            Assert.Contains("container inspect", h.Runner.Calls[1]);
            Assert.Equal(2, h.Runner.Calls.Count);
            Assert.Equal(Situation.Stopped, h.Controller.State.Situation);
        }

        [Fact]
        public void A_failed_start_leaves_the_state_true_and_shows_the_reason()
        {
            Harness h = Ready(Docker.Exited());
            h.StartAnswer = Docker.Refused("port is already allocated");
            CommandOutcome o = h.Controller.Start();
            Assert.False(o.Ok);
            Assert.Equal(Situation.Stopped, h.Controller.State.Situation);
            Assert.Equal(IconLook.Grey, h.Controller.State.Look);
            Assert.Contains("Start failed: Error response from daemon: port is already allocated", h.Controller.State.MenuLine);
            Assert.Equal(2, h.Runner.Calls.Count); // the start, and the look at docker right after it
        }

        [Fact]
        public void A_failed_stop_leaves_it_running_and_shows_the_reason()
        {
            Harness h = Ready(Docker.Running());
            h.StopAnswer = Docker.Refused("permission denied");
            Assert.False(h.Controller.Stop().Ok);
            Assert.Equal(Situation.Running, h.Controller.State.Situation);
            Assert.StartsWith("Running on port 7880 - Stop failed:", h.Controller.State.MenuLine);
        }

        [Fact]
        public void A_failed_command_shows_what_docker_says_even_when_that_is_a_different_state()
        {
            Harness h = Ready(Docker.Exited());
            h.StartAnswer = new ProcessResult { TimedOut = true };
            h.Runner.On("container inspect", () => Docker.Down());
            Assert.False(h.Controller.Start().Ok);
            Assert.Equal(Situation.DockerNotRunning, h.Controller.State.Situation);
        }

        [Fact]
        public void The_reason_stays_until_the_next_command_or_a_change_of_situation()
        {
            Harness h = Ready(Docker.Exited());
            h.StartAnswer = Docker.Refused("boom");
            h.Controller.Start();
            h.Controller.Refresh("poll");
            Assert.Contains("boom", h.Controller.State.MenuLine);
            h.ContainerAnswer = Docker.Running(); // something else started it
            h.Controller.Refresh("poll");
            Assert.DoesNotContain("boom", h.Controller.State.MenuLine);
            Assert.True(h.Log.Has("last error cleared"));
        }

        [Fact]
        public void The_next_command_clears_the_last_reason()
        {
            Harness h = Ready(Docker.Exited());
            h.StartAnswer = Docker.Refused("boom");
            h.Controller.Start();
            h.StartAnswer = Docker.Ok();
            Assert.True(h.Controller.Start().Ok);
            Assert.Equal("Running on port 7880", h.Controller.State.MenuLine);
        }

        [Fact]
        public void Start_on_a_running_satellite_calls_nothing()
        {
            Harness h = Ready(Docker.Running());
            Assert.True(h.Controller.Start().Ok);
            Assert.Equal(0, h.Runner.Count("docker start"));
        }

        [Fact]
        public void Stop_on_a_stopped_satellite_calls_nothing()
        {
            Harness h = Ready(Docker.Exited());
            Assert.True(h.Controller.Stop().Ok);
            Assert.Equal(0, h.Runner.Count("docker stop"));
        }

        [Fact]
        public void Start_with_docker_not_running_or_the_container_missing_refuses_without_a_call()
        {
            Harness down = Ready(Docker.Down());
            CommandOutcome a = down.Controller.Start();
            Assert.False(a.Ok);
            Assert.Contains("Docker Desktop is not running", a.Reason);
            Assert.Equal(0, down.Runner.Count("docker start"));
            Harness missing = Ready(Docker.Missing());
            CommandOutcome b = missing.Controller.Start();
            Assert.False(b.Ok);
            Assert.Contains("choose Repair", b.Reason);
            Assert.Equal(0, missing.Runner.Count("docker start"));
        }

        [Fact]
        public void Stop_while_it_is_restarting_is_allowed()
        {
            Harness h = Ready(Docker.Restarting());
            Assert.True(h.Controller.Stop().Ok);
            Assert.Equal(1, h.Runner.Count("docker stop"));
        }

        [Fact]
        public void Commands_with_no_satellite_refuse_with_the_reason()
        {
            var h = new Harness { PlanAnswer = Plans.NewSatellite() };
            h.Controller.Refresh("test");
            Assert.Contains("no satellite is set up", h.Controller.Start().Reason);
            Assert.Contains("no satellite is set up", h.Controller.Stop().Reason);
            Assert.Contains("no satellite is set up", h.Controller.SetAutostart(true).Reason);
        }

        [Fact]
        public void An_unknown_command_is_refused()
        {
            Harness h = Ready(Docker.Running());
            Assert.False(h.Controller.Execute("pause").Ok);
            // Only the fresh look that Execute takes first: no start, stop, pause or script command of any kind.
            Assert.Equal(0, h.Runner.Count("docker start") + h.Runner.Count("docker stop") + h.Runner.Count("docker pause") + h.Runner.Count("-Autostart"));
        }

        [Fact]
        public void Execute_looks_at_docker_first_so_a_stale_picture_does_not_decide()
        {
            Harness h = Ready(Docker.Running());
            h.ContainerAnswer = Docker.Exited(); // stopped behind the icon's back
            CommandOutcome o = h.Controller.Execute("start");
            Assert.True(o.Ok);
            Assert.Contains("container inspect", h.Runner.Calls[0]);
            Assert.Equal(StartCall, h.Runner.Calls[1]);
        }
    }

    public class AutostartTests
    {
        private static Harness Ready(string autostart, ProcessResult container)
        {
            var h = new Harness(false, container) { PlanAnswer = Plans.Existing(autostart) };
            h.Controller.Refresh("setup");
            h.Runner.Clear();
            return h;
        }

        private const string ScriptPrefix = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"C:\\app\\satellite-setup.ps1\" -Root \"C:\\sat\" ";

        [Fact]
        public void Turning_it_off_runs_the_script_with_autostart_off_and_no_prompt_then_reads_the_plan_again()
        {
            Harness h = Ready("on", Docker.Running());
            h.AutostartAnswer = ProcessResult.Exited(0, "", "");
            h.Runner.On("-Autostart", () =>
            {
                h.PlanAnswer = Plans.Existing("off"); // the script recorded it
                return ProcessResult.Exited(0, "", "");
            });
            Assert.True(h.Controller.SetAutostart(false).Ok);
            Assert.Equal(ScriptPrefix + "-Autostart off -NoPrompt", h.Runner.Calls[0]);
            Assert.Equal(SatelliteScript.AutostartTimeoutMs, h.Runner.Timeouts[0]);
            Assert.Equal(ScriptPrefix + "-ShowPlan", h.Runner.Calls[1]);
            Assert.False(h.Controller.State.AutostartOn);
        }

        [Fact]
        public void Turning_it_on_uses_autostart_on()
        {
            Harness h = Ready("off", Docker.Running());
            h.Runner.On("-Autostart", () =>
            {
                h.PlanAnswer = Plans.Existing("on");
                return ProcessResult.Exited(0, "", "");
            });
            Assert.True(h.Controller.SetAutostart(true).Ok);
            Assert.Equal(ScriptPrefix + "-Autostart on -NoPrompt", h.Runner.Calls[0]);
            Assert.True(h.Controller.State.AutostartOn);
        }

        [Fact]
        public void A_refusal_shows_the_scripts_reason_and_the_tick_stays_as_it_was()
        {
            Harness h = Ready("on", Docker.Running());
            h.AutostartAnswer = ProcessResult.Exited(1, "ERROR: Docker did not answer.\n", "");
            CommandOutcome o = h.Controller.SetAutostart(false);
            Assert.False(o.Ok);
            Assert.Equal("Docker did not answer.", o.Reason);
            Assert.True(h.Controller.State.AutostartOn);
            Assert.Contains("Changing the autostart setting failed: Docker did not answer.", h.Controller.State.MenuLine);
        }

        [Fact]
        public void It_is_refused_without_calling_the_script_while_docker_is_not_running()
        {
            Harness h = Ready("on", Docker.Down());
            CommandOutcome o = h.Controller.SetAutostart(false);
            Assert.False(o.Ok);
            Assert.Equal(0, h.Runner.Count("-Autostart"));
            Assert.True(h.Controller.State.AutostartOn);
        }

        [Fact]
        public void A_script_that_prints_no_ERROR_line_still_gives_a_reason()
        {
            Harness h = Ready("on", Docker.Running());
            h.AutostartAnswer = ProcessResult.Exited(3, "something went wrong\n", "");
            Assert.Equal("something went wrong", h.Controller.SetAutostart(false).Reason);
            h.AutostartAnswer = ProcessResult.Exited(3, "", "");
            Assert.Contains("exit code 3", h.Controller.SetAutostart(false).Reason);
        }

        [Fact]
        public void Autostart_through_execute_issues_the_same_call()
        {
            Harness h = Ready("on", Docker.Running());
            Assert.True(h.Controller.Execute("autostart-off").Ok);
            Assert.Equal(1, h.Runner.Count("-Autostart off -NoPrompt"));
        }
    }

    // Design: "Start with Windows, made true". Only an icon started with --signin, with the recorded setting on, starts
    // a stopped satellite once Docker answers, and only once.
    public class SignInStartTests
    {
        private static Harness Make(bool signIn, string autostart, ProcessResult container)
        {
            return new Harness(signIn, container) { PlanAnswer = Plans.Existing(autostart) };
        }

        [Fact]
        public void With_signin_and_the_setting_on_a_stopped_satellite_is_started_exactly_once()
        {
            Harness h = Make(true, "on", Docker.Exited());
            TrayState s = h.Controller.Refresh("start");
            Assert.Equal(1, h.Runner.Count("docker start " + Plans.Container));
            Assert.Equal(Situation.Running, s.Situation);
            h.Controller.Refresh("poll");
            h.Controller.Refresh("poll");
            Assert.Equal(1, h.Runner.Count("docker start"));
        }

        [Fact]
        public void The_user_stopping_it_afterwards_is_not_undone()
        {
            Harness h = Make(true, "on", Docker.Exited());
            h.Controller.Refresh("start");
            Assert.True(h.Controller.Stop().Ok);
            h.Controller.Refresh("poll");
            Assert.Equal(1, h.Runner.Count("docker start"));
            Assert.Equal(Situation.Stopped, h.Controller.State.Situation);
        }

        [Fact]
        public void Without_signin_it_never_starts_the_satellite_by_itself()
        {
            Harness h = Make(false, "on", Docker.Exited());
            h.Controller.Refresh("start");
            h.Controller.Refresh("poll");
            Assert.Equal(0, h.Runner.Count("docker start"));
            Assert.Equal(Situation.Stopped, h.Controller.State.Situation);
        }

        [Fact]
        public void With_the_setting_off_signin_does_not_start_it()
        {
            Harness h = Make(true, "off", Docker.Exited());
            h.Controller.Refresh("start");
            h.Controller.Refresh("poll");
            Assert.Equal(0, h.Runner.Count("docker start"));
            Assert.True(h.Log.Has("sign-in start: not needed (satellite Stopped, autostart off)"));
        }

        [Fact]
        public void A_satellite_that_is_already_running_or_restarting_is_left_alone_and_uses_up_the_start()
        {
            Harness running = Make(true, "on", Docker.Running());
            running.Controller.Refresh("start");
            running.ContainerAnswer = Docker.Exited(); // stopped later by the user
            running.Controller.Refresh("poll");
            Assert.Equal(0, running.Runner.Count("docker start"));
            Harness restarting = Make(true, "on", Docker.Restarting());
            restarting.Controller.Refresh("start");
            Assert.Equal(0, restarting.Runner.Count("docker start"));
        }

        [Fact]
        public void It_waits_for_docker_to_answer_and_then_starts_once()
        {
            Harness h = Make(true, "on", Docker.Down());
            h.Controller.Refresh("start");
            h.Controller.Refresh("poll");
            Assert.Equal(0, h.Runner.Count("docker start"));
            h.ContainerAnswer = Docker.Exited(); // Docker Desktop is up now
            h.Controller.Refresh("poll");
            Assert.Equal(1, h.Runner.Count("docker start"));
            Assert.Equal(Situation.Running, h.Controller.State.Situation);
            h.ContainerAnswer = Docker.Exited();
            h.Controller.Refresh("poll");
            Assert.Equal(1, h.Runner.Count("docker start"));
        }

        [Fact]
        public void It_waits_while_no_satellite_can_be_read_and_never_starts_a_missing_container()
        {
            Harness h = Make(true, "on", Docker.Exited());
            h.PlanAnswer = Plans.Refused("drive not there");
            h.Controller.Refresh("start");
            Assert.Equal(0, h.Runner.Count("docker"));
            h.PlanAnswer = Plans.Existing("on");
            h.Controller.Refresh("poll");
            Assert.Equal(1, h.Runner.Count("docker start"));
            Harness missing = Make(true, "on", Docker.Missing());
            missing.Controller.Refresh("start");
            Assert.Equal(0, missing.Runner.Count("docker start"));
        }

        [Fact]
        public void A_failed_sign_in_start_shows_the_reason_and_is_not_retried()
        {
            Harness h = Make(true, "on", Docker.Exited());
            h.StartAnswer = Docker.Refused("port is already allocated");
            TrayState s = h.Controller.Refresh("start");
            Assert.Equal(Situation.Stopped, s.Situation);
            Assert.Contains("Starting the satellite at sign-in failed: Error response from daemon: port is already allocated", s.MenuLine);
            h.Controller.Refresh("poll");
            h.Controller.Refresh("poll");
            Assert.Equal(1, h.Runner.Count("docker start"));
        }
    }
}
