using System;
using System.IO;
using Xunit;

namespace VocalisSatelliteTray.Tests
{
    public class CommandLineTests
    {
        [Fact]
        public void No_argument_shows_the_icon_without_the_sign_in_rule()
        {
            ParsedCommand c = CommandLine.Parse(new string[0]);
            Assert.Equal(CommandKind.RunIcon, c.Kind);
            Assert.False(c.SignIn);
        }

        [Fact]
        public void Signin_shows_the_icon_with_the_sign_in_rule()
        {
            ParsedCommand c = CommandLine.Parse(new[] { "--signin" });
            Assert.Equal(CommandKind.RunIcon, c.Kind);
            Assert.True(c.SignIn);
        }

        [Fact]
        public void Exit_is_exit()
        {
            Assert.Equal(CommandKind.Exit, CommandLine.Parse(new[] { "--exit" }).Kind);
        }

        [Theory]
        [InlineData("start")]
        [InlineData("stop")]
        [InlineData("autostart-on")]
        [InlineData("autostart-off")]
        public void Do_takes_each_of_the_four_verbs(string verb)
        {
            ParsedCommand c = CommandLine.Parse(new[] { "--do", verb });
            Assert.Equal(CommandKind.Do, c.Kind);
            Assert.Equal(verb, c.Verb);
        }

        [Fact]
        public void Verbs_and_options_are_case_insensitive()
        {
            Assert.Equal("autostart-on", CommandLine.Parse(new[] { "--DO", "Autostart-ON" }).Verb);
            Assert.True(CommandLine.Parse(new[] { "--SignIn" }).SignIn);
        }

        [Theory]
        [InlineData("--do")]
        [InlineData("--do", "pause")]
        [InlineData("--do", "start", "stop")]
        [InlineData("--signin", "--exit")]
        [InlineData("--exit", "now")]
        [InlineData("--bogus")]
        [InlineData("start")]
        public void Anything_else_is_invalid_and_says_why(params string[] args)
        {
            ParsedCommand c = CommandLine.Parse(args);
            Assert.Equal(CommandKind.Invalid, c.Kind);
            Assert.False(string.IsNullOrEmpty(c.Error));
        }
    }

    public class InstanceNamesTests
    {
        [Fact]
        public void The_same_folder_gives_the_same_names_whatever_its_case_or_trailing_slash()
        {
            InstanceNames a = InstanceNames.For(@"C:\Users\x\AppData\Local\Programs\VocalisSatellite", "S-1");
            InstanceNames b = InstanceNames.For(@"c:\users\X\appdata\local\programs\vocalissatellite\", "S-1");
            Assert.Equal(a.Mutex, b.Mutex);
            Assert.Equal(a.Pipe, b.Pipe);
        }

        [Fact]
        public void Two_installs_in_different_folders_never_collide()
        {
            InstanceNames a = InstanceNames.For(@"C:\a\VocalisSatellite", "S-1");
            InstanceNames b = InstanceNames.For(@"C:\a\VocalisSatelliteTest", "S-1");
            Assert.NotEqual(a.Mutex, b.Mutex);
            Assert.NotEqual(a.Pipe, b.Pipe);
        }

        [Fact]
        public void Two_users_of_one_folder_get_their_own_pipe()
        {
            Assert.NotEqual(InstanceNames.For(@"C:\a", "S-1").Pipe, InstanceNames.For(@"C:\a", "S-2").Pipe);
        }

        [Fact]
        public void The_mutex_is_in_the_session_namespace_and_names_are_legal()
        {
            InstanceNames n = InstanceNames.For(@"C:\a", "S-1");
            Assert.StartsWith("Local\\", n.Mutex);
            Assert.DoesNotContain("\\", n.Pipe);
            Assert.True(n.Mutex.Length < 100 && n.Pipe.Length < 100);
        }
    }

    public class ArgumentQuotingTests
    {
        [Theory]
        [InlineData(@"C:\a b\c", "\"C:\\a b\\c\"")]
        [InlineData(@"C:\dir\", "\"C:\\dir\\\\\"")]
        [InlineData("say \"hi\"", "\"say \\\"hi\\\"\"")]
        [InlineData("", "\"\"")]
        public void Quotes_by_the_windows_rules(string value, string expected)
        {
            Assert.Equal(expected, ArgumentQuoting.Quote(value));
        }
    }

    public class PathResolverTests
    {
        [Fact]
        public void Finds_the_first_folder_and_the_first_extension_in_order()
        {
            var existing = new[] { @"C:\second\docker.cmd", @"C:\first\docker.exe", @"C:\second\docker.exe" };
            Func<string, bool> exists = p => Array.Exists(existing, e => string.Equals(e, p, StringComparison.OrdinalIgnoreCase));
            // Windows file names are case-insensitive; PATHEXT is upper case, so the answer's extension is too.
            Assert.Equal(@"C:\first\docker.exe", PathResolver.Resolve("docker", @"C:\first;C:\second", ".COM;.EXE;.BAT;.CMD", exists), true);
            Assert.Equal(@"C:\second\docker.exe", PathResolver.Resolve("docker", @"C:\none;C:\second", ".COM;.EXE;.BAT;.CMD", exists), true);
        }

        [Fact]
        public void A_stand_in_cmd_first_on_the_path_wins_over_a_later_exe()
        {
            var existing = new[] { @"C:\stand\docker.cmd", @"C:\real\docker.exe" };
            Assert.Equal(@"C:\stand\docker.cmd", PathResolver.Resolve("docker", @"C:\stand;C:\real", null,
                p => Array.Exists(existing, e => string.Equals(e, p, StringComparison.OrdinalIgnoreCase))), true);
        }

        [Fact]
        public void Not_found_is_null_and_a_path_is_left_alone()
        {
            Assert.Null(PathResolver.Resolve("docker", @"C:\a;C:\b", null, p => false));
            Assert.Equal(@"C:\x\y.exe", PathResolver.Resolve(@"C:\x\y.exe", @"C:\a", null, p => false));
        }
    }

    public class PlanParserTests
    {
        [Fact]
        public void An_existing_satellite_gives_every_fact_the_tray_uses()
        {
            SatellitePlan plan = PlanParser.Parse(Plans.Existing("off", "kitchen", 7890));
            Assert.Equal(PlanKind.Existing, plan.Kind);
            Assert.Equal("kitchen", plan.Name);
            Assert.Equal(7890, plan.Port);
            Assert.Equal(Plans.Container, plan.Container);
            Assert.False(plan.AutostartOn);
            Assert.Equal(@"C:\sat\data\certs\cert.pem", plan.CertificateFile);
            Assert.True(plan.SetupFinished);
            Assert.False(plan.NeedsSecret);
        }

        [Fact]
        public void No_satellite_is_new_and_makes_no_demands()
        {
            Assert.Equal(PlanKind.New, PlanParser.Parse(Plans.NewSatellite()).Kind);
        }

        [Fact]
        public void A_refusal_gives_the_scripts_reason_after_ERROR()
        {
            SatellitePlan plan = PlanParser.Parse(Plans.Refused("The satellite folder Z:\\sat is not there."));
            Assert.Equal(PlanKind.Error, plan.Kind);
            Assert.Equal("The satellite folder Z:\\sat is not there.", plan.Error);
        }

        [Fact]
        public void A_failure_with_no_ERROR_line_still_says_what_happened()
        {
            SatellitePlan plan = PlanParser.Parse(ProcessResult.Exited(5, "", "boom\n"));
            Assert.Equal(PlanKind.Error, plan.Kind);
            Assert.Contains("exit code 5", plan.Error);
            Assert.Contains("boom", plan.Error);
        }

        [Fact]
        public void A_missing_program_and_a_timeout_are_errors()
        {
            Assert.Equal(PlanKind.Error, PlanParser.Parse(new ProcessResult { StartError = "powershell.exe could not be started" }).Kind);
            Assert.Equal(PlanKind.Error, PlanParser.Parse(new ProcessResult { TimedOut = true }).Kind);
        }

        [Fact]
        public void An_absent_autostart_line_reads_as_on()
        {
            ProcessResult r = ProcessResult.Exited(0, "SATELLITE=existing\nNAME=a\nPORT=7880\nCONTAINER=c1\n", "");
            Assert.True(PlanParser.Parse(r).AutostartOn);
        }

        [Theory]
        [InlineData("PORT=0")]
        [InlineData("PORT=abc")]
        [InlineData("PORT=70000")]
        public void A_bad_port_is_an_error(string portLine)
        {
            ProcessResult r = ProcessResult.Exited(0, "SATELLITE=existing\nNAME=a\n" + portLine + "\nCONTAINER=c1\n", "");
            Assert.Equal(PlanKind.Error, PlanParser.Parse(r).Kind);
        }

        [Theory]
        [InlineData("")]
        [InlineData("a b")]
        [InlineData("a&calc")]
        [InlineData("-rm")]
        [InlineData("a\"b")]
        public void A_container_name_docker_would_not_accept_is_an_error_and_never_reaches_a_command_line(string container)
        {
            ProcessResult r = ProcessResult.Exited(0, "SATELLITE=existing\nNAME=a\nPORT=7880\nCONTAINER=" + container + "\n", "");
            Assert.Equal(PlanKind.Error, PlanParser.Parse(r).Kind);
        }

        [Fact]
        public void Output_with_no_SATELLITE_line_is_an_error()
        {
            Assert.Equal(PlanKind.Error, PlanParser.Parse(ProcessResult.Exited(0, "NAME=x\n", "")).Kind);
        }

        [Fact]
        public void Windows_line_endings_and_a_byte_order_mark_are_tolerated()
        {
            ProcessResult r = ProcessResult.Exited(0, "\ufeffSATELLITE=existing\r\nNAME=a\r\nPORT=7880\r\nCONTAINER=c1\r\n", "");
            Assert.Equal(PlanKind.Existing, PlanParser.Parse(r).Kind);
        }
    }

    public class DockerInspectTests
    {
        [Fact]
        public void Running_restarting_and_not_running_are_told_apart()
        {
            Assert.Equal(ContainerState.Running, DockerCli.ParseInspect(Docker.Running()).State);
            Assert.Equal(ContainerState.Starting, DockerCli.ParseInspect(Docker.Restarting()).State);
            Assert.Equal(ContainerState.Starting, DockerCli.ParseInspect(ProcessResult.Exited(0, "running true\n", "")).State);
            Assert.Equal(ContainerState.Stopped, DockerCli.ParseInspect(Docker.Exited()).State);
            Assert.Equal(ContainerState.Stopped, DockerCli.ParseInspect(ProcessResult.Exited(0, "created false\n", "")).State);
            Assert.Equal(ContainerState.Stopped, DockerCli.ParseInspect(ProcessResult.Exited(0, "paused false\n", "")).State);
        }

        [Fact]
        public void No_such_container_is_missing_but_an_unanswering_docker_is_not()
        {
            Assert.Equal(ContainerState.Missing, DockerCli.ParseInspect(Docker.Missing()).State);
            Assert.Equal(ContainerState.Missing, DockerCli.ParseInspect(ProcessResult.Exited(1, "[]\n", "Error response from daemon: No such object: x\n")).State);
            Assert.Equal(ContainerState.DockerDown, DockerCli.ParseInspect(Docker.Down()).State);
        }

        [Fact]
        public void A_docker_that_cannot_be_started_or_times_out_is_not_running()
        {
            Assert.Equal(ContainerState.DockerDown, DockerCli.ParseInspect(new ProcessResult { StartError = "docker could not be started" }).State);
            Assert.Equal(ContainerState.DockerDown, DockerCli.ParseInspect(new ProcessResult { TimedOut = true }).State);
            Assert.Equal(ContainerState.DockerDown, DockerCli.ParseInspect(ProcessResult.Exited(0, "", "")).State);
        }

        [Fact]
        public void The_inspect_command_line_is_exact_and_bounded()
        {
            var runner = new FakeRunner();
            runner.On("container inspect", Docker.Running());
            new DockerCli(runner, new ListLog()).Inspect("c1");
            Assert.Equal("docker container inspect --format \"{{.State.Status}} {{.State.Restarting}}\" c1", runner.Calls[0]);
            Assert.Equal(DockerCli.InspectTimeoutMs, runner.Timeouts[0]);
        }

        [Fact]
        public void Start_and_stop_are_plain_docker_start_and_stop_with_their_own_bounds()
        {
            var runner = new FakeRunner();
            runner.On("docker", Docker.Ok());
            var cli = new DockerCli(runner, new ListLog());
            Assert.True(cli.Start("c1").Ok);
            Assert.True(cli.Stop("c1").Ok);
            Assert.Equal(new[] { "docker start c1", "docker stop c1" }, runner.Calls.ToArray());
            Assert.Equal(new[] { DockerCli.StartTimeoutMs, DockerCli.StopTimeoutMs }, runner.Timeouts.ToArray());
        }

        [Fact]
        public void A_refused_start_gives_dockers_first_line_as_the_reason()
        {
            var runner = new FakeRunner();
            runner.On("docker start", Docker.Refused("driver failed programming external connectivity: port is already allocated"));
            CommandOutcome o = new DockerCli(runner, new ListLog()).Start("c1");
            Assert.False(o.Ok);
            Assert.Equal("Error response from daemon: driver failed programming external connectivity: port is already allocated", o.Reason);
        }

        [Fact]
        public void A_timed_out_or_unstartable_docker_is_a_failure_with_a_reason()
        {
            var runner = new FakeRunner();
            runner.On("docker stop", new ProcessResult { TimedOut = true });
            runner.On("docker start", new ProcessResult { StartError = "docker could not be started: not found" });
            var cli = new DockerCli(runner, new ListLog());
            Assert.Contains("did not finish within 90 seconds", cli.Stop("c1").Reason);
            Assert.Contains("not found", cli.Start("c1").Reason);
        }
    }

    public class StateFileTests : IDisposable
    {
        private readonly string folder = Path.Combine(Path.GetTempPath(), "vst-" + Guid.NewGuid().ToString("N"));

        public StateFileTests()
        {
            Directory.CreateDirectory(folder);
        }

        public void Dispose()
        {
            Directory.Delete(folder, true);
        }

        [Fact]
        public void Reads_only_ROOT_whatever_else_the_file_holds()
        {
            string path = Path.Combine(folder, "satellite-installer-state.txt");
            File.WriteAllText(path, "VERSION=1.2\r\nROOT=C:\\Users\\x\\a b=c\\satellite\r\nIMAGE=foo\r\nPORT=7880\r\n");
            Assert.Equal(@"C:\Users\x\a b=c\satellite", new StateFile(path).ReadRoot());
        }

        [Fact]
        public void A_missing_file_or_one_without_ROOT_names_no_satellite()
        {
            string path = Path.Combine(folder, "state.txt");
            var file = new StateFile(path);
            Assert.Null(file.ReadRoot());
            Assert.Equal("missing", file.Stamp());
            File.WriteAllText(path, "PORT=7880\n");
            Assert.Null(file.ReadRoot());
        }

        [Fact]
        public void The_stamp_changes_when_the_file_does()
        {
            string path = Path.Combine(folder, "state.txt");
            File.WriteAllText(path, "ROOT=C:\\a\n");
            var file = new StateFile(path);
            string before = file.Stamp();
            File.WriteAllText(path, "ROOT=C:\\bb\n");
            File.SetLastWriteTimeUtc(path, DateTime.UtcNow.AddMinutes(1));
            Assert.NotEqual(before, file.Stamp());
        }
    }
}
