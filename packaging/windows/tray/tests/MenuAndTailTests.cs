using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using Xunit;

namespace VocalisSatelliteTray.Tests
{
    // The notification-area menu as data (order, words, when each item can be chosen), with no window.
    public class MenuTests
    {
        private static TrayState Build(SatellitePlan plan, ContainerState? docker)
        {
            return TrayState.Build(@"C:\sat", plan, docker.HasValue ? new DockerStatus { State = docker.Value } : null, true, "");
        }

        [Fact]
        public void The_menu_holds_the_designed_items_in_the_designed_order_with_tail_the_satellite_log_directly_below_open_the_setup_log()
        {
            string[] texts = TrayMenu.Layout.Select(e => e == MenuEntry.Separator ? "-" : e == MenuEntry.Status ? "(status line)" : TrayMenu.Text(e)).ToArray();
            Assert.Equal(new[]
            {
                "(status line)", "-",
                "Start satellite", "Stop satellite", "Start the satellite when Windows starts", "-",
                "Show certificate file", "Change secret\u2026", "New certificate\u2026", "Repair\u2026", "Open the setup log", "Tail the satellite log", "Satellite guide", "-",
                "Close this icon (the satellite keeps running)"
            }, texts);
            int log = Array.IndexOf(TrayMenu.Layout, MenuEntry.SetupLog);
            Assert.Equal(MenuEntry.TailLog, TrayMenu.Layout[log + 1]);
            Assert.Equal("Tail the satellite log", TrayMenu.TailLogText);
            Assert.Equal(1, TrayMenu.Layout.Count(e => e == MenuEntry.TailLog));
        }

        [Fact]
        public void The_tail_item_is_available_whenever_the_satellite_folder_exists_whatever_docker_is_doing()
        {
            foreach (ContainerState docker in new[] { ContainerState.Running, ContainerState.Starting, ContainerState.Stopped, ContainerState.Missing, ContainerState.DockerDown })
            {
                TrayState state = Build(PlanParser.Parse(Plans.Existing()), docker);
                Assert.True(TrayMenu.IsEnabled(MenuEntry.TailLog, state), docker.ToString());
                Assert.True(state.TailLogEnabled, docker.ToString());
            }
        }

        [Fact]
        public void The_tail_item_is_greyed_with_no_satellite_and_with_an_unreadable_folder_and_before_the_first_answer()
        {
            Assert.False(TrayMenu.IsEnabled(MenuEntry.TailLog, Build(SatellitePlan.None(), null)));
            Assert.False(TrayMenu.IsEnabled(MenuEntry.TailLog, Build(SatellitePlan.Failed("The folder is not there."), null)));
            Assert.False(TrayMenu.IsEnabled(MenuEntry.TailLog, TrayState.Initial()));
        }

        [Fact]
        public void The_tail_item_and_the_setup_log_item_are_available_in_exactly_the_same_states()
        {
            var states = new List<TrayState> { TrayState.Initial(), Build(SatellitePlan.None(), null), Build(SatellitePlan.Failed("x"), null) };
            foreach (ContainerState docker in Enum.GetValues(typeof(ContainerState)))
                states.Add(Build(PlanParser.Parse(Plans.Existing()), docker));
            foreach (TrayState state in states)
                Assert.Equal(TrayMenu.IsEnabled(MenuEntry.SetupLog, state), TrayMenu.IsEnabled(MenuEntry.TailLog, state));
        }

        [Fact]
        public void The_other_items_keep_the_rules_the_state_gives_them()
        {
            TrayState running = Build(PlanParser.Parse(Plans.Existing()), ContainerState.Running);
            Assert.True(TrayMenu.IsEnabled(MenuEntry.Stop, running));
            Assert.False(TrayMenu.IsEnabled(MenuEntry.Start, running));
            Assert.True(TrayMenu.IsEnabled(MenuEntry.Exit, TrayState.Initial()));
            Assert.True(TrayMenu.IsEnabled(MenuEntry.Repair, Build(SatellitePlan.None(), null)));
            Assert.False(TrayMenu.IsEnabled(MenuEntry.Guide, Build(SatellitePlan.None(), null)));
            Assert.False(TrayMenu.IsEnabled(MenuEntry.Autostart, Build(PlanParser.Parse(Plans.Existing()), ContainerState.DockerDown)));
        }
    }

    // "Tail the satellite log": what the shell is asked to start, for which folder, and what a failure does.
    public class TailLogTests : IDisposable
    {
        private const string PowerShell = @"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";
        private readonly string folder = Path.Combine(Path.GetTempPath(), "vst-" + Guid.NewGuid().ToString("N"));
        private readonly string root;
        private readonly List<string> started = new List<string>();
        private readonly List<string> failures = new List<string>();
        private readonly ListLog log = new ListLog();

        public TailLogTests()
        {
            Directory.CreateDirectory(folder);
            root = Path.Combine(folder, "satellite folder");
            Directory.CreateDirectory(root);
            File.WriteAllText(Path.Combine(folder, "satellite-log-tail.ps1"), "# viewer");
        }

        public void Dispose()
        {
            Directory.Delete(folder, true);
        }

        private RealShell Shell(string seam, Func<string, string, int> starter = null)
        {
            return new RealShell(folder, name => name == RealShell.SeamVariable ? seam : null,
                starter ?? ((file, args) => { started.Add(file + " " + args); return 4242; }),
                () => new DateTime(2026, 10, 11, 12, 0, 0, DateTimeKind.Utc), log);
        }

        [Fact]
        public void It_asks_the_shell_for_windows_powershell_with_the_viewer_the_log_of_the_planned_folder_and_the_window_title()
        {
            ShellCommands.TailLog(Shell(null), folder, root, PowerShell, failures.Add);
            Assert.Empty(failures);
            Assert.Equal(new[]
            {
                PowerShell + " -NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(folder, "satellite-log-tail.ps1") + "\" -Path \""
                    + Path.Combine(root, "logs", "satellite.log") + "\" -Title \"Vocalis Satellite log\""
            }, started.ToArray());
        }

        [Fact]
        public void The_log_does_not_have_to_exist_yet_the_viewer_waits_for_it()
        {
            Assert.False(File.Exists(Path.Combine(root, "logs", "satellite.log")));
            ShellCommands.TailLog(Shell(null), folder, root, PowerShell, failures.Add);
            Assert.Single(started);
            Assert.Empty(failures);
        }

        [Fact]
        public void The_log_is_in_the_folder_of_the_plan_not_in_the_programs_folder()
        {
            string other = Path.Combine(folder, "other satellite");
            ShellCommands.TailLog(Shell(null), folder, other, PowerShell, failures.Add);
            Assert.Contains("-Path \"" + Path.Combine(other, "logs", "satellite.log") + "\"", started.Single());
            Assert.DoesNotContain(Path.Combine(root, "logs"), started.Single());
        }

        [Fact]
        public void A_test_identity_install_adds_its_identity_to_the_title_the_same_way_its_other_names_do()
        {
            Assert.Equal("Vocalis Satellite log", ShellCommands.LogWindowTitle(@"C:\Users\x\AppData\Local\Programs\VocalisSatellite"));
            Assert.Equal("Vocalis Satellite log (test margintest)", ShellCommands.LogWindowTitle(@"C:\Users\x\AppData\Local\Programs\VocalisSatellite-test-margintest"));
            Assert.Equal("Vocalis Satellite log (test margintest)", ShellCommands.LogWindowTitle(@"C:\Users\x\AppData\Local\Programs\VocalisSatellite-test-margintest\"));
            Assert.Equal("Vocalis Satellite log", ShellCommands.LogWindowTitle(@"C:\Programs\VocalisSatellite-test-"));
            Assert.Equal("Vocalis Satellite log", ShellCommands.LogWindowTitle(""));
        }

        [Fact]
        public void Paths_with_spaces_and_trailing_backslashes_are_quoted_for_the_command_line()
        {
            Assert.Equal("-NoProfile -ExecutionPolicy Bypass -File \"C:\\a b\\t.ps1\" -Path \"D:\\sat dir\\\\\" -Title \"Vocalis Satellite log\"",
                ShellCommands.TailArguments(@"C:\a b\t.ps1", @"D:\sat dir\", "Vocalis Satellite log"));
        }

        [Fact]
        public void With_the_test_seam_nothing_is_started_and_the_line_that_would_have_been_is_recorded()
        {
            ShellCommands.TailLog(Shell("1"), folder, root, PowerShell, failures.Add);
            Assert.Empty(started);
            Assert.Empty(failures);
            string[] lines = File.ReadAllText(Path.Combine(folder, "test-shell-actions.log")).Split(new[] { '\n' }, StringSplitOptions.RemoveEmptyEntries);
            Assert.Single(lines);
            Assert.StartsWith("2026-10-11T12:00:00Z would start: " + PowerShell + " -NoProfile -ExecutionPolicy Bypass -File ", lines[0]);
            Assert.Contains("satellite-log-tail.ps1", lines[0]);
            Assert.Contains(Path.Combine(root, "logs", "satellite.log"), lines[0]);
        }

        [Fact]
        public void The_tray_log_gets_one_line_with_the_process_id_when_the_window_is_started()
        {
            ShellCommands.TailLog(Shell(null), folder, root, PowerShell, failures.Add);
            string line = Assert.Single(log.Lines, l => l.StartsWith("shell: started "));
            Assert.EndsWith("(pid 4242)", line);
            Assert.Contains("satellite-log-tail.ps1", line);
        }

        [Fact]
        public void A_start_failure_is_logged_and_reported_as_a_reason_not_thrown()
        {
            Func<string, string, int> failing = (file, args) => { throw new Win32Exception(2, "The system cannot find the file specified"); };
            ShellCommands.TailLog(Shell(null, failing), folder, root, PowerShell, failures.Add);
            string reason = Assert.Single(failures);
            Assert.Contains("could not be started", reason);
            Assert.Contains("The system cannot find the file specified", reason);
            Assert.Single(log.Lines, l => l.StartsWith("shell: could not start " + PowerShell));
            Assert.DoesNotContain(log.Lines, l => l.StartsWith("shell: started "));
        }

        [Fact]
        public void A_start_that_produced_no_process_is_also_a_reason_not_a_crash()
        {
            Func<string, string, int> none = (file, args) => { throw new InvalidOperationException("Windows did not create a process"); };
            ShellCommands.TailLog(Shell(null, none), folder, root, PowerShell, failures.Add);
            Assert.Single(failures);
            Assert.Single(log.Lines, l => l.StartsWith("shell: could not start "));
        }

        [Fact]
        public void A_missing_viewer_or_an_unknown_folder_is_a_reason_and_nothing_is_started()
        {
            File.Delete(Path.Combine(folder, "satellite-log-tail.ps1"));
            ShellCommands.TailLog(Shell(null), folder, root, PowerShell, failures.Add);
            Assert.Single(failures);
            Assert.Contains("satellite-log-tail.ps1", failures[0]);
            File.WriteAllText(Path.Combine(folder, "satellite-log-tail.ps1"), "# viewer");
            ShellCommands.TailLog(Shell(null), folder, "", PowerShell, failures.Add);
            ShellCommands.TailLog(Shell(null), folder, null, PowerShell, failures.Add);
            Assert.Equal(3, failures.Count);
            Assert.Empty(started);
        }

        [Fact]
        public void Windows_powershell_is_found_by_its_full_path_when_it_is_there()
        {
            string path = ShellCommands.PowerShellPath();
            Assert.True(File.Exists(path) || path == "powershell.exe");
            Assert.EndsWith("powershell.exe", path);
        }
    }
}
