using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace VocalisSatelliteTray
{
    // What one child program did. StartError is set when it never started (not found on PATH, not allowed); TimedOut
    // when it was killed for running past its bound.
    internal sealed class ProcessResult
    {
        public int ExitCode;
        public string Stdout = "";
        public string Stderr = "";
        public bool TimedOut;
        public string StartError;
        public long ElapsedMs;

        public bool Started { get { return StartError == null; } }
        public bool Ok { get { return Started && !TimedOut && ExitCode == 0; } }

        public static ProcessResult Exited(int code, string stdout, string stderr)
        {
            return new ProcessResult { ExitCode = code, Stdout = stdout ?? "", Stderr = stderr ?? "" };
        }
    }

    // Every docker.exe and script call goes through this, so the unit tests can stand in for both and assert the exact
    // command lines. Always hidden, always bounded.
    internal interface IProcessRunner
    {
        ProcessResult Run(string fileName, string arguments, int timeoutMs);
    }

    // The Windows command-line rules for one argument: it is quoted, a quote inside becomes \", and backslashes before a
    // quote (or at the end, before the closing quote) are doubled.
    internal static class ArgumentQuoting
    {
        public static string Quote(string value)
        {
            var sb = new StringBuilder("\"");
            int backslashes = 0;
            foreach (char c in value ?? "")
            {
                if (c == '\\')
                {
                    backslashes++;
                }
                else if (c == '"')
                {
                    sb.Append('\\', backslashes * 2 + 1).Append('"');
                    backslashes = 0;
                }
                else
                {
                    sb.Append('\\', backslashes).Append(c);
                    backslashes = 0;
                }
            }
            sb.Append('\\', backslashes * 2).Append('"');
            return sb.ToString();
        }
    }

    // A bare program name ("docker") found the way a command prompt would: each PATH folder in order, each PATHEXT
    // extension in order. CreateProcess alone only appends .exe, which is all docker.exe needs, but the tests put a
    // stand-in docker.cmd first on PATH. The current folder is never searched.
    internal static class PathResolver
    {
        public static string Resolve(string name, string pathVariable, string pathExt, Func<string, bool> fileExists)
        {
            if (string.IsNullOrEmpty(name)) return null;
            if (name.IndexOfAny(new[] { '\\', '/', ':' }) >= 0) return name;
            var extensions = new List<string>();
            foreach (string ext in (string.IsNullOrEmpty(pathExt) ? ".COM;.EXE;.BAT;.CMD" : pathExt).Split(';'))
                if (ext.Trim().Length > 0) extensions.Add(ext.Trim());
            bool hasExtension = Path.GetExtension(name).Length > 0;
            foreach (string rawDir in (pathVariable ?? "").Split(';'))
            {
                string dir = rawDir.Trim().Trim('"');
                if (dir.Length == 0) continue;
                if (hasExtension)
                {
                    string direct;
                    try { direct = Path.Combine(dir, name); }
                    catch (ArgumentException) { continue; }
                    if (fileExists(direct)) return direct;
                }
                foreach (string ext in extensions)
                {
                    string candidate;
                    try { candidate = Path.Combine(dir, name + ext); }
                    catch (ArgumentException) { continue; }
                    if (fileExists(candidate)) return candidate;
                }
            }
            return null;
        }
    }

    internal sealed class ProcessRunner : IProcessRunner
    {
        private const int MaxCapturedChars = 64 * 1024;
        private readonly ILog log;

        public ProcessRunner(ILog log)
        {
            this.log = log;
        }

        public ProcessResult Run(string fileName, string arguments, int timeoutMs)
        {
            var watch = Stopwatch.StartNew();
            string resolved = PathResolver.Resolve(fileName, Environment.GetEnvironmentVariable("PATH"),
                Environment.GetEnvironmentVariable("PATHEXT"), File.Exists) ?? fileName;
            var startInfo = new ProcessStartInfo(resolved, arguments)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8
            };
            var stdout = new StringBuilder();
            var stderr = new StringBuilder();
            Process process;
            try
            {
                process = new Process { StartInfo = startInfo };
                process.OutputDataReceived += (s, e) => Capture(stdout, e.Data);
                process.ErrorDataReceived += (s, e) => Capture(stderr, e.Data);
                process.Start();
            }
            catch (Win32Exception ex)
            {
                log.Write("run " + fileName + ": could not start (" + ex.Message + ") after " + watch.ElapsedMilliseconds + " ms");
                return new ProcessResult { StartError = fileName + " could not be started: " + ex.Message, ElapsedMs = watch.ElapsedMilliseconds };
            }
            catch (InvalidOperationException ex)
            {
                log.Write("run " + fileName + ": could not start (" + ex.Message + ") after " + watch.ElapsedMilliseconds + " ms");
                return new ProcessResult { StartError = fileName + " could not be started: " + ex.Message, ElapsedMs = watch.ElapsedMilliseconds };
            }
            using (process)
            {
                try { process.StandardInput.Close(); }
                catch (IOException ex) { log.Write("run " + fileName + ": closing standard input failed: " + ex.Message); }
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                if (!process.WaitForExit(timeoutMs))
                {
                    try { process.Kill(); }
                    catch (InvalidOperationException ex) { log.Write("run " + fileName + ": it ended while being killed: " + ex.Message); }
                    catch (Win32Exception ex) { log.Write("run " + fileName + ": could not be killed: " + ex.Message); }
                    process.WaitForExit(5000);
                    log.Write("run " + fileName + " " + arguments + ": no answer within " + timeoutMs + " ms, killed");
                    return new ProcessResult { TimedOut = true, ExitCode = -1, Stdout = stdout.ToString(), Stderr = stderr.ToString(), ElapsedMs = watch.ElapsedMilliseconds };
                }
                process.WaitForExit(); // drains the asynchronous output readers
                var result = ProcessResult.Exited(process.ExitCode, stdout.ToString(), stderr.ToString());
                result.ElapsedMs = watch.ElapsedMilliseconds;
                log.Write("run " + fileName + " " + arguments + ": exit " + result.ExitCode + " in " + result.ElapsedMs + " ms");
                return result;
            }
        }

        private static void Capture(StringBuilder into, string line)
        {
            if (line == null) return;
            lock (into)
            {
                if (into.Length < MaxCapturedChars) into.Append(line).Append('\n');
            }
        }
    }
}
