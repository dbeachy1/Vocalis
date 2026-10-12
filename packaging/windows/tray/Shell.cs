using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;

namespace VocalisSatelliteTray
{
    // Starts the programs the menu opens (Explorer, Notepad, the setup program) without waiting for them. Returns the
    // reason when one could not be started, null when it was.
    internal interface IShell
    {
        string Start(string fileName, string arguments);
    }

    internal sealed class RealShell : IShell
    {
        private readonly string workingFolder;
        private readonly Func<string, string> environment;
        private readonly Func<string, string, int> processStarter;
        private readonly Func<DateTime> utcNow;
        private readonly string seamLogPath;
        private readonly ILog log;

        // Test seam shared with the setup program: when VOCALIS_SATELLITE_TEST_NO_SHELL is 1 nothing is started; one line
        // describing what would have been started is appended to <exe folder>\test-shell-actions.log instead.
        public const string SeamVariable = "VOCALIS_SATELLITE_TEST_NO_SHELL";
        public const string SeamLogName = "test-shell-actions.log";

        public RealShell(string exeFolder, Func<string, string> environment, Func<string, string, int> processStarter, Func<DateTime> utcNow, ILog log)
        {
            workingFolder = exeFolder;
            this.environment = environment;
            this.processStarter = processStarter;
            this.utcNow = utcNow;
            this.log = log;
            seamLogPath = Path.Combine(exeFolder, SeamLogName);
        }

        // Starts the program without waiting for it and returns its process id. A console program started here (the log
        // viewer of the "Tail the satellite log" item) gets a console window of its own, because this program has none
        // and CreateNoWindow is not set.
        public static int StartForReal(string fileName, string arguments, string workingFolder)
        {
            var info = new ProcessStartInfo(fileName, arguments) { UseShellExecute = false, WorkingDirectory = workingFolder };
            using (Process started = Process.Start(info))
            {
                if (started == null) throw new InvalidOperationException("Windows did not create a process for " + fileName);
                return started.Id;
            }
        }

        public string Start(string fileName, string arguments)
        {
            if (environment(SeamVariable) == "1")
            {
                string line = utcNow().ToString("yyyy-MM-ddTHH:mm:ssZ") + " would start: " + fileName + (arguments.Length > 0 ? " " + arguments : "");
                try
                {
                    File.AppendAllText(seamLogPath, line + "\n", new UTF8Encoding(false));
                }
                catch (IOException ex)
                {
                    log.Write("shell: the test seam log could not be written: " + ex.Message);
                    return "the test seam log could not be written: " + ex.Message;
                }
                log.Write("shell: " + SeamVariable + "=1, nothing started: " + fileName + " " + arguments);
                return null;
            }
            try
            {
                int processId = processStarter(fileName, arguments);
                log.Write("shell: started " + fileName + " " + arguments + " (pid " + processId + ")");
                return null;
            }
            catch (Win32Exception ex)
            {
                log.Write("shell: could not start " + fileName + ": " + ex.Message);
                return fileName + " could not be started: " + ex.Message;
            }
            catch (InvalidOperationException ex)
            {
                // Process.Start reports a start that produced no process this way (a null result is also one).
                log.Write("shell: could not start " + fileName + ": " + ex.Message);
                return fileName + " could not be started: " + ex.Message;
            }
        }
    }

    // What each menu action starts, so the unit tests can check the command lines without a window.
    internal static class ShellCommands
    {
        public const string SetupProgram = "Vocalis-Satellite-Setup.exe";
        public const string Guide = "Vocalis-Satellite-Guide.md";
        // The log viewer installed beside the tray program, and the satellite's own log file under the satellite folder.
        public const string TailScript = "satellite-log-tail.ps1";
        public const string SatelliteLogFile = "satellite.log";
        public const string LogWindowTitleBase = "Vocalis Satellite log";
        // A test-identity install (build-satellite-installer.ps1 -TestIdentity <word>) lives in a program folder named
        // VocalisSatellite-test-<word>; the tray program takes every other name it shares from its own folder the same way.
        private const string TestFolderPrefix = "VocalisSatellite-test-";

        public static void ShowCertificate(IShell shell, string certificateFile, Action<string> failed)
        {
            if (!File.Exists(certificateFile)) { failed("The certificate file is not there: " + certificateFile); return; }
            Report(shell.Start("explorer.exe", "/select," + ArgumentQuoting.Quote(certificateFile)), failed);
        }

        public static void OpenGuide(IShell shell, string exeFolder, Action<string> failed)
        {
            string guide = Path.Combine(exeFolder, Guide);
            if (!File.Exists(guide)) { failed("The guide is not there: " + guide); return; }
            // A .md file has no program of its own on Windows, so it is opened in Notepad.
            Report(shell.Start("notepad.exe", ArgumentQuoting.Quote(guide)), failed);
        }

        public static void OpenSetupLog(IShell shell, string root, Action<string> failed)
        {
            string newest = NewestSetupLog(root);
            if (newest == null) { failed("There is no setup log yet in " + Path.Combine(root ?? "", "logs")); return; }
            Report(shell.Start("notepad.exe", ArgumentQuoting.Quote(newest)), failed);
        }

        // "Tail the satellite log" (October 11, 2026; Doug: "pop up in a new command prompt, simply tailing the log. And if
        // I restart the satellite, keep that tail open"): a console window of its own that prints the last lines of
        // <root>\logs\satellite.log and follows the file by name, so it stays open and keeps following while the satellite
        // is stopped, started, restarted or recreated, and after this icon has exited. The file does not have to exist
        // yet: the viewer says so and waits for it.
        public static void TailLog(IShell shell, string exeFolder, string root, string powerShell, Action<string> failed)
        {
            if (string.IsNullOrEmpty(root)) { failed("The satellite folder is not known, so there is no log to follow."); return; }
            string script = Path.Combine(exeFolder, TailScript);
            if (!File.Exists(script)) { failed("The log viewer is not there: " + script); return; }
            Report(shell.Start(powerShell, TailArguments(script, LogPath(root), LogWindowTitle(exeFolder))), failed);
        }

        public static string LogPath(string root)
        {
            return Path.Combine(root, "logs", SatelliteLogFile);
        }

        public static string LogWindowTitle(string exeFolder)
        {
            string name = Path.GetFileName((exeFolder ?? "").TrimEnd('\\', '/'));
            if (name.StartsWith(TestFolderPrefix, StringComparison.OrdinalIgnoreCase) && name.Length > TestFolderPrefix.Length)
                return LogWindowTitleBase + " (test " + name.Substring(TestFolderPrefix.Length) + ")";
            return LogWindowTitleBase;
        }

        public static string TailArguments(string script, string logPath, string title)
        {
            return "-NoProfile -ExecutionPolicy Bypass -File " + ArgumentQuoting.Quote(script) + " -Path " + ArgumentQuoting.Quote(logPath)
                + " -Title " + ArgumentQuoting.Quote(title);
        }

        // Windows PowerShell 5.1 by its full path, so a program of that name earlier on PATH is never run in its place.
        public static string PowerShellPath()
        {
            string full = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
            return File.Exists(full) ? full : "powershell.exe";
        }

        // mode: repair, newsecret or newcertificate, the installed setup program's three maintenance modes.
        public static void RunSetup(IShell shell, string exeFolder, string mode, Action<string> failed)
        {
            string setup = Path.Combine(exeFolder, SetupProgram);
            if (!File.Exists(setup)) { failed("The setup program is not there: " + setup); return; }
            Report(shell.Start(setup, "/MODE=" + mode), failed);
        }

        // The newest <root>\logs\setup-*.log by when it was written, then by name (the name holds a UTC time).
        public static string NewestSetupLog(string root)
        {
            if (string.IsNullOrEmpty(root)) return null;
            string folder = Path.Combine(root, "logs");
            if (!Directory.Exists(folder)) return null;
            return Directory.GetFiles(folder, "setup-*.log")
                .Select(f => new FileInfo(f))
                .OrderByDescending(f => f.LastWriteTimeUtc).ThenByDescending(f => f.Name, StringComparer.Ordinal)
                .Select(f => f.FullName).FirstOrDefault();
        }

        private static void Report(string reason, Action<string> failed)
        {
            if (reason != null) failed(reason);
        }
    }
}
