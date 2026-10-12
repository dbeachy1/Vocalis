using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace VocalisSatelliteTray
{
    // The command-line modes (--exit, --do) of a Windows-subsystem program print to the console that started them. A
    // program of that kind has no console and, when launched from a prompt without redirection, no standard handles.
    // This attaches to the parent's console and points the standard output and error handles at it, before the first
    // Console call; when the caller redirected the output (the tests, the setup program) the handles already exist and
    // are left alone.
    internal static class ConsoleHost
    {
        private const int AttachParentProcess = -1;
        private const int StdOutputHandle = -11;
        private const int StdErrorHandle = -12;
        private const uint GenericWrite = 0x40000000;
        private const uint FileShareWrite = 2;
        private const uint OpenExisting = 3;

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AttachConsole(int processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetStdHandle(int which);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetStdHandle(int which, IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

        public static void EnsureStandardStreams()
        {
            IntPtr error = GetStdHandle(StdErrorHandle);
            IntPtr output = GetStdHandle(StdOutputHandle);
            bool hasError = error != IntPtr.Zero && error != new IntPtr(-1);
            bool hasOutput = output != IntPtr.Zero && output != new IntPtr(-1);
            if (hasError && hasOutput) return;
            if (!AttachConsole(AttachParentProcess)) return; // started with no console at all (a shortcut, the Run key): nothing to print to
            IntPtr console = CreateFile("CONOUT$", GenericWrite, FileShareWrite, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero);
            if (console == new IntPtr(-1)) return;
            if (!hasOutput) SetStdHandle(StdOutputHandle, console);
            if (!hasError) SetStdHandle(StdErrorHandle, console);
        }
    }

    // Docker Desktop's own sign-in start is a value named "Docker Desktop" under the user's Run key; the icon says
    // "and is not set to start when you sign in" when it is not there.
    internal static class DockerDesktopSetting
    {
        public static bool StartsAtSignIn(ILog log)
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run"))
                {
                    return key != null && key.GetValue("Docker Desktop") != null;
                }
            }
            catch (System.Security.SecurityException ex)
            {
                log.Write("Docker Desktop sign-in setting could not be read: " + ex.Message);
                return true; // unknown: do not add a sentence that may be false
            }
            catch (UnauthorizedAccessException ex)
            {
                log.Write("Docker Desktop sign-in setting could not be read: " + ex.Message);
                return true;
            }
        }
    }
}
