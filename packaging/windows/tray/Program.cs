using System;
using System.Diagnostics;
using System.IO;
using System.Security.Principal;
using System.Windows.Forms;

namespace VocalisSatelliteTray
{
    // VocalisSatelliteTray.exe: the satellite's notification-area icon (design, "Satellite setup program and tray icon
    // for Windows"). No argument shows the icon; --signin is the same plus the one start-at-sign-in rule; --exit closes
    // the running icon; --do start|stop|autostart-on|autostart-off hands one command to the running icon.
    internal static class Program
    {
        private const string SecretFileName = "pairing-secret.tmp";
        private const string StateFileName = "satellite-installer-state.txt";
        private const string ScriptName = "satellite-setup.ps1";

        [STAThread]
        private static int Main(string[] args)
        {
            ParsedCommand command = CommandLine.Parse(args);
            string exeFolder = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
            InstanceNames names = InstanceNames.For(exeFolder, WindowsIdentity.GetCurrent().User.Value);
            var log = new FileLog(Path.Combine(exeFolder, "satellite-tray.log"));
            log.Write("start: args=[" + string.Join(" ", args) + "] mode=" + command.Kind + " folder=" + exeFolder + " mutex=" + names.Mutex);

            switch (command.Kind)
            {
                case CommandKind.Invalid:
                    ConsoleHost.EnsureStandardStreams();
                    Console.Error.WriteLine(command.Error);
                    Console.Error.WriteLine(CommandLine.Usage);
                    return ControlCommands.BadUsage;
                case CommandKind.Exit:
                    ConsoleHost.EnsureStandardStreams();
                    return Report(log, "--exit", ControlCommands.RunExit(names, Console.Out, Console.Error, 3000, 10000, 10000));
                case CommandKind.Do:
                    ConsoleHost.EnsureStandardStreams();
                    // 150 s covers the longest bounded command (docker stop, 90 s) with room to spare.
                    return Report(log, "--do " + command.Verb, ControlCommands.RunDo(names, command.Verb, Console.Out, Console.Error, 3000, 150000));
                default:
                    return RunIcon(command, exeFolder, names, log);
            }
        }

        private static int Report(ILog log, string what, int code)
        {
            log.Write(what + ": exit code " + code);
            return code;
        }

        private static int RunIcon(ParsedCommand command, string exeFolder, InstanceNames names, ILog log)
        {
            using (SingleInstance instance = SingleInstance.TryAcquire(names.Mutex))
            {
                if (instance == null)
                {
                    log.Write("second instance: the mutex already exists, exiting at once");
                    return 0;
                }
                log.Write("first instance: mutex owned, signin=" + command.SignIn);
                DeleteLeftoverSecretFile(exeFolder, log);

                AppDomain.CurrentDomain.UnhandledException += (s, e) => log.Write("unhandled exception: " + e.ExceptionObject);
                Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
                Application.ThreadException += (s, e) => log.Write("user-interface thread exception: " + e.Exception);
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                var runner = new ProcessRunner(log);
                string powerShell = ShellCommands.PowerShellPath();
                var script = new SatelliteScript(runner, powerShell, Path.Combine(exeFolder, ScriptName), File.Exists, log);
                var controller = new SatelliteController(new DockerCli(runner, log), script, new StateFile(Path.Combine(exeFolder, StateFileName)),
                    () => DockerDesktopSetting.StartsAtSignIn(log), log, command.SignIn);
                var shell = new RealShell(exeFolder, Environment.GetEnvironmentVariable,
                    (file, arguments) => RealShell.StartForReal(file, arguments, exeFolder), () => DateTime.UtcNow, log);

                using (var context = new TrayContext(controller, shell, exeFolder, names, log))
                {
                    Application.Run(context);
                }
                log.Write("message loop ended; releasing the mutex");
                instance.Release();
            }
            return 0;
        }

        // The pairing secret is written next to the program for the length of one setup run and deleted by the setup
        // program. The icon deletes any left behind (a setup program killed mid-run) at every start, without reading it.
        private static void DeleteLeftoverSecretFile(string exeFolder, ILog log)
        {
            string path = Path.Combine(exeFolder, SecretFileName);
            try
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                    log.Write("deleted a leftover " + SecretFileName + " (contents not read)");
                }
            }
            catch (IOException ex)
            {
                log.Write("could not delete " + SecretFileName + ": " + ex.Message);
            }
            catch (UnauthorizedAccessException ex)
            {
                log.Write("could not delete " + SecretFileName + ": " + ex.Message);
            }
        }
    }
}
