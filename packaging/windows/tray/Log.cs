using System;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace VocalisSatelliteTray
{
    // Where the tray program records its decisions, with values: what came in, what was decided, what went out, the
    // counts and the milliseconds. The log never holds the pairing secret or the private key (the tray never reads
    // either) and never file contents.
    internal interface ILog
    {
        void Write(string message);
    }

    internal sealed class NullLog : ILog
    {
        public static readonly NullLog Instance = new NullLog();

        public void Write(string message)
        {
        }
    }

    // <exe folder>\satellite-tray.log. When it passes MaxBytes it is moved to satellite-tray.log.1 (replacing the older
    // one), so the folder holds at most about two times MaxBytes of log.
    internal sealed class FileLog : ILog
    {
        public const long MaxBytes = 256 * 1024;

        private readonly string path;
        private readonly object gate = new object();
        private readonly int processId = Process.GetCurrentProcess().Id;

        public FileLog(string path)
        {
            this.path = path;
        }

        public void Write(string message)
        {
            string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " [" + processId + "] " + message + "\n";
            lock (gate)
            {
                try
                {
                    var info = new FileInfo(path);
                    if (info.Exists && info.Length > MaxBytes)
                    {
                        string older = path + ".1";
                        if (File.Exists(older)) File.Delete(older);
                        File.Move(path, older);
                    }
                    File.AppendAllText(path, line, new UTF8Encoding(false));
                }
                catch (IOException ex)
                {
                    // The log is evidence, never a reason to stop the icon. The only place left to say so is the debugger.
                    Debug.WriteLine("satellite-tray.log could not be written: " + ex.Message);
                }
                catch (UnauthorizedAccessException ex)
                {
                    Debug.WriteLine("satellite-tray.log could not be written: " + ex.Message);
                }
            }
        }
    }
}
