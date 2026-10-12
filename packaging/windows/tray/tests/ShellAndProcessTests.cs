using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Reflection;
using Xunit;

namespace VocalisSatelliteTray.Tests
{
    public class ShellTests : IDisposable
    {
        private readonly string folder = Path.Combine(Path.GetTempPath(), "vst-" + Guid.NewGuid().ToString("N"));
        private readonly List<string> started = new List<string>();
        private readonly List<string> failures = new List<string>();
        private readonly ListLog log = new ListLog();

        public ShellTests()
        {
            Directory.CreateDirectory(folder);
        }

        public void Dispose()
        {
            Directory.Delete(folder, true);
        }

        private RealShell Shell(string seam)
        {
            return new RealShell(folder, name => name == RealShell.SeamVariable ? seam : null, (file, args) => { started.Add(file + " " + args); return 4242; },
                () => new DateTime(2026, 10, 11, 12, 0, 0, DateTimeKind.Utc), log);
        }

        private string SeamLog()
        {
            return File.ReadAllText(Path.Combine(folder, "test-shell-actions.log"));
        }

        [Fact]
        public void With_the_test_seam_nothing_is_started_and_one_line_per_action_is_appended()
        {
            string setup = Path.Combine(folder, "Vocalis-Satellite-Setup.exe");
            File.WriteAllText(setup, "x");
            RealShell shell = Shell("1");
            ShellCommands.RunSetup(shell, folder, "repair", failures.Add);
            ShellCommands.RunSetup(shell, folder, "newsecret", failures.Add);
            Assert.Empty(started);
            Assert.Empty(failures);
            string[] lines = SeamLog().Split(new[] { '\n' }, StringSplitOptions.RemoveEmptyEntries);
            Assert.Equal(2, lines.Length);
            Assert.Equal("2026-10-11T12:00:00Z would start: " + setup + " /MODE=repair", lines[0]);
            Assert.EndsWith(" /MODE=newsecret", lines[1]);
        }

        [Fact]
        public void Without_the_seam_the_program_is_started_and_no_seam_log_is_written()
        {
            File.WriteAllText(Path.Combine(folder, "Vocalis-Satellite-Guide.md"), "# guide");
            ShellCommands.OpenGuide(Shell(null), folder, failures.Add);
            Assert.Equal(new[] { "notepad.exe \"" + Path.Combine(folder, "Vocalis-Satellite-Guide.md") + "\"" }, started.ToArray());
            Assert.False(File.Exists(Path.Combine(folder, "test-shell-actions.log")));
        }

        [Fact]
        public void The_seam_is_only_on_for_exactly_one()
        {
            File.WriteAllText(Path.Combine(folder, "Vocalis-Satellite-Guide.md"), "# guide");
            ShellCommands.OpenGuide(Shell("0"), folder, failures.Add);
            ShellCommands.OpenGuide(Shell("true"), folder, failures.Add);
            Assert.Equal(2, started.Count);
        }

        [Fact]
        public void The_three_maintenance_modes_pass_the_exact_mode_switch()
        {
            string setup = Path.Combine(folder, "Vocalis-Satellite-Setup.exe");
            File.WriteAllText(setup, "x");
            foreach (string mode in new[] { "newsecret", "newcertificate", "repair" })
                ShellCommands.RunSetup(Shell(null), folder, mode, failures.Add);
            Assert.Equal(new[] { setup + " /MODE=newsecret", setup + " /MODE=newcertificate", setup + " /MODE=repair" }, started.ToArray());
        }

        [Fact]
        public void A_missing_setup_program_or_guide_or_certificate_is_a_reason_not_a_crash()
        {
            ShellCommands.RunSetup(Shell(null), folder, "repair", failures.Add);
            ShellCommands.OpenGuide(Shell(null), folder, failures.Add);
            ShellCommands.ShowCertificate(Shell(null), Path.Combine(folder, "cert.pem"), failures.Add);
            Assert.Equal(3, failures.Count);
            Assert.Empty(started);
        }

        [Fact]
        public void Show_certificate_opens_explorer_with_the_file_selected()
        {
            string cert = Path.Combine(folder, "a b", "cert.pem");
            Directory.CreateDirectory(Path.GetDirectoryName(cert));
            File.WriteAllText(cert, "public");
            ShellCommands.ShowCertificate(Shell(null), cert, failures.Add);
            Assert.Equal(new[] { "explorer.exe /select,\"" + cert + "\"" }, started.ToArray());
        }

        [Fact]
        public void The_setup_log_is_the_newest_setup_log_in_the_satellite_folders_logs_folder()
        {
            string logs = Path.Combine(folder, "logs");
            Directory.CreateDirectory(logs);
            string older = Path.Combine(logs, "setup-20261010-100000-1.log");
            string newer = Path.Combine(logs, "setup-20261011-100000-2.log");
            File.WriteAllText(older, "a");
            File.WriteAllText(newer, "b");
            File.WriteAllText(Path.Combine(logs, "satellite.log"), "not a setup log");
            File.SetLastWriteTimeUtc(older, new DateTime(2026, 10, 10, 10, 0, 0, DateTimeKind.Utc));
            File.SetLastWriteTimeUtc(newer, new DateTime(2026, 10, 11, 10, 0, 0, DateTimeKind.Utc));
            File.SetLastWriteTimeUtc(Path.Combine(logs, "satellite.log"), new DateTime(2026, 10, 12, 10, 0, 0, DateTimeKind.Utc));
            Assert.Equal(newer, ShellCommands.NewestSetupLog(folder));
            ShellCommands.OpenSetupLog(Shell(null), folder, failures.Add);
            Assert.Equal(new[] { "notepad.exe \"" + newer + "\"" }, started.ToArray());
        }

        [Fact]
        public void No_setup_log_is_a_reason()
        {
            Assert.Null(ShellCommands.NewestSetupLog(folder));
            ShellCommands.OpenSetupLog(Shell(null), folder, failures.Add);
            Assert.Single(failures);
            Assert.Empty(started);
        }
    }

    public class FileLogTests : IDisposable
    {
        private readonly string folder = Path.Combine(Path.GetTempPath(), "vst-" + Guid.NewGuid().ToString("N"));

        public FileLogTests()
        {
            Directory.CreateDirectory(folder);
        }

        public void Dispose()
        {
            Directory.Delete(folder, true);
        }

        [Fact]
        public void Lines_are_timestamped_and_it_rotates_past_its_limit()
        {
            string path = Path.Combine(folder, "satellite-tray.log");
            var log = new FileLog(path);
            log.Write("hello");
            Assert.Matches(@"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} \[\d+\] hello\n$", File.ReadAllText(path));
            File.WriteAllText(path, new string('x', (int)FileLog.MaxBytes + 10));
            log.Write("after");
            Assert.True(File.Exists(path + ".1"));
            Assert.Contains("after", File.ReadAllText(path));
            Assert.True(new FileInfo(path).Length < 1000);
        }

        [Fact]
        public void A_log_that_cannot_be_written_never_throws()
        {
            new FileLog(Path.Combine(folder, "no-such-folder", "x.log")).Write("hello");
        }
    }

    // Real child processes, only cmd.exe, to prove the runner's bounds and capture.
    public class ProcessRunnerTests
    {
        private readonly ProcessRunner runner = new ProcessRunner(NullLog.Instance);

        [Fact]
        public void Captures_output_and_the_exit_code()
        {
            ProcessResult r = runner.Run("cmd.exe", "/c echo hello & echo oops 1>&2 & exit 3", 10000);
            Assert.True(r.Started);
            Assert.Equal(3, r.ExitCode);
            Assert.Contains("hello", r.Stdout);
            Assert.Contains("oops", r.Stderr);
            Assert.False(r.Ok);
        }

        [Fact]
        public void A_program_that_runs_past_its_bound_is_killed_and_said_to_have_timed_out()
        {
            // powershell.exe itself sleeps (no child process is left behind when the runner kills it).
            ProcessResult r = runner.Run("powershell.exe", "-NoProfile -NonInteractive -Command Start-Sleep -Seconds 60", 3000);
            Assert.True(r.TimedOut);
            Assert.False(r.Ok);
            Assert.True(r.ElapsedMs < 8000);
        }

        [Fact]
        public void A_program_that_is_not_there_is_a_start_error()
        {
            ProcessResult r = runner.Run("vocalis-no-such-program-" + Guid.NewGuid().ToString("N"), "", 5000);
            Assert.False(r.Started);
            Assert.False(string.IsNullOrEmpty(r.StartError));
        }

        [Fact]
        public void A_stand_in_cmd_first_on_the_path_is_found_for_a_bare_name()
        {
            string folder = Path.Combine(Path.GetTempPath(), "vst-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(folder);
            string oldPath = Environment.GetEnvironmentVariable("PATH");
            try
            {
                File.WriteAllText(Path.Combine(folder, "vst-standin.cmd"), "@echo standin %1 %2\r\n");
                Environment.SetEnvironmentVariable("PATH", folder + ";" + oldPath);
                ProcessResult r = runner.Run("vst-standin", "alpha beta", 10000);
                Assert.True(r.Ok, r.StartError + r.Stderr);
                Assert.Contains("standin alpha beta", r.Stdout);
            }
            finally
            {
                Environment.SetEnvironmentVariable("PATH", oldPath);
                Directory.Delete(folder, true);
            }
        }
    }

    // The three looks are embedded in the program, so the right picture shows without the loose .ico files.
    public class IconResourceTests
    {
        private static readonly string[] Names = { TrayIcons.Colour, TrayIcons.Stopped, TrayIcons.NoDocker };

        [Fact]
        public void The_three_looks_are_embedded_resources_and_are_icon_files()
        {
            Assembly program = typeof(TrayIcons).Assembly;
            foreach (string name in Names)
            {
                using (Stream s = program.GetManifestResourceStream(name))
                {
                    Assert.NotNull(s);
                    var header = new byte[4];
                    Assert.Equal(4, s.Read(header, 0, 4));
                    Assert.Equal(new byte[] { 0, 0, 1, 0 }, header);
                }
            }
        }

        [Fact]
        public void Each_look_loads_as_an_icon_at_the_small_and_the_large_size()
        {
            foreach (string name in Names)
            {
                using (Icon small = TrayIcons.Load(name, new Size(16, 16)))
                using (Icon large = TrayIcons.Load(name, new Size(32, 32)))
                {
                    Assert.Equal(16, small.Width);
                    Assert.Equal(32, large.Width);
                }
            }
        }

        [Fact]
        public void Each_situation_maps_to_its_look()
        {
            Assert.Equal(TrayIcons.Colour, TrayIcons.ResourceFor(IconLook.Colour));
            Assert.Equal(TrayIcons.Stopped, TrayIcons.ResourceFor(IconLook.Grey));
            Assert.Equal(TrayIcons.NoDocker, TrayIcons.ResourceFor(IconLook.GreyWithMark));
        }
    }
}
