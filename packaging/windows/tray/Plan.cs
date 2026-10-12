using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace VocalisSatelliteTray
{
    internal enum PlanKind
    {
        Existing,   // SATELLITE=existing: a satellite folder with its settings
        New,        // SATELLITE=new: nothing is set up
        Error       // the script refused or did not answer: the folder cannot be read
    }

    // What `satellite-setup.ps1 -Root <folder> -ShowPlan` said. The tray has no parser of satellite.env of its own:
    // this is the only source of the container name, the port, the autostart value and the certificate file.
    internal sealed class SatellitePlan
    {
        public PlanKind Kind;
        public string Error = "";
        public string SatelliteId = "";
        public string Name = "";
        public int Port;
        public string Container = "";
        public bool AutostartOn = true;
        public string Image = "";
        public string Addresses = "";
        public bool NeedsSecret;
        public bool NeedsCertificate;
        public bool SetupFinished;
        public string CertificateFile = "";
        public string Fingerprint = "";

        public static SatellitePlan None()
        {
            return new SatellitePlan { Kind = PlanKind.New };
        }

        public static SatellitePlan Failed(string reason)
        {
            return new SatellitePlan { Kind = PlanKind.Error, Error = reason };
        }
    }

    internal static class PlanParser
    {
        // A container name is passed to docker.exe on a command line, so it is held to Docker's own naming rule.
        private static readonly Regex ContainerName = new Regex("^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$", RegexOptions.Compiled);

        public static bool IsValidContainerName(string name)
        {
            return name != null && ContainerName.IsMatch(name);
        }

        public static SatellitePlan Parse(ProcessResult result)
        {
            if (!result.Started) return SatellitePlan.Failed(result.StartError);
            if (result.TimedOut) return SatellitePlan.Failed("the setup script did not answer in time");
            if (result.ExitCode != 0)
            {
                string reason = ErrorLine(result.Stdout) ?? ErrorLine(result.Stderr);
                if (reason == null) reason = "the setup script stopped with exit code " + result.ExitCode + (LastLine(result.Stderr) != null ? ": " + LastLine(result.Stderr) : "");
                return SatellitePlan.Failed(reason);
            }
            var values = KeyValues(result.Stdout);
            string kind;
            if (!values.TryGetValue("SATELLITE", out kind))
                return SatellitePlan.Failed("the setup script's plan did not say whether a satellite exists");
            if (kind == "new") return SatellitePlan.None();
            if (kind != "existing")
                return SatellitePlan.Failed("the setup script's plan said SATELLITE=" + kind);
            var plan = new SatellitePlan { Kind = PlanKind.Existing };
            plan.SatelliteId = Get(values, "SATELLITE_ID");
            plan.Name = Get(values, "NAME");
            plan.Container = Get(values, "CONTAINER");
            plan.Image = Get(values, "IMAGE");
            plan.Addresses = Get(values, "ADDRESSES");
            plan.CertificateFile = Get(values, "CERTIFICATE_FILE");
            plan.Fingerprint = Get(values, "FINGERPRINT");
            plan.NeedsSecret = Get(values, "NEEDS_SECRET") == "yes";
            plan.NeedsCertificate = Get(values, "NEEDS_CERTIFICATE") == "yes";
            plan.SetupFinished = Get(values, "SETUP_FINISHED") == "yes";
            // satellite.env written before the setting existed has no AUTOSTART line; the design reads that as on.
            plan.AutostartOn = Get(values, "AUTOSTART") != "off";
            int port;
            if (!int.TryParse(Get(values, "PORT"), out port) || port < 1 || port > 65535)
                return SatellitePlan.Failed("the setup script's plan gave no valid port (PORT=" + Get(values, "PORT") + ")");
            plan.Port = port;
            if (!IsValidContainerName(plan.Container))
                return SatellitePlan.Failed("the setup script's plan gave no valid container name (CONTAINER=" + plan.Container + ")");
            if (plan.Name.Length == 0) plan.Name = plan.SatelliteId.Length > 0 ? plan.SatelliteId : "satellite";
            return plan;
        }

        public static Dictionary<string, string> KeyValues(string text)
        {
            var values = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (string raw in (text ?? "").Split('\n'))
            {
                string line = raw.TrimEnd('\r').TrimStart('﻿');
                int eq = line.IndexOf('=');
                if (eq <= 0) continue;
                values[line.Substring(0, eq).Trim()] = line.Substring(eq + 1).Trim();
            }
            return values;
        }

        private static string Get(Dictionary<string, string> values, string key)
        {
            string value;
            return values.TryGetValue(key, out value) ? value : "";
        }

        // The reason after the first "ERROR:" line, which is how the script reports every refusal.
        public static string ErrorLine(string text)
        {
            foreach (string raw in (text ?? "").Split('\n'))
            {
                string line = raw.Trim();
                if (line.StartsWith("ERROR:", StringComparison.Ordinal))
                {
                    string reason = line.Substring(6).Trim();
                    return reason.Length > 0 ? reason : "the setup script reported an error";
                }
            }
            return null;
        }

        public static string LastLine(string text)
        {
            string last = null;
            foreach (string raw in (text ?? "").Split('\n'))
                if (raw.Trim().Length > 0) last = raw.Trim();
            return last;
        }
    }

    // The state file the setup program writes in the program folder: KEY=VALUE, UTF-8 without a byte-order mark. The
    // tray reads only ROOT, the satellite folder; everything else comes from the plan.
    internal interface IStateFile
    {
        // Changes whenever the file does; "missing" when it is not there.
        string Stamp();
        // The satellite folder, or null when the file is missing or names none.
        string ReadRoot();
    }

    internal sealed class StateFile : IStateFile
    {
        private readonly string path;

        public StateFile(string path)
        {
            this.path = path;
        }

        public string Stamp()
        {
            var info = new FileInfo(path);
            return info.Exists ? info.Length + ":" + info.LastWriteTimeUtc.Ticks : "missing";
        }

        public string ReadRoot()
        {
            string text;
            try
            {
                text = File.ReadAllText(path, new UTF8Encoding(false));
            }
            catch (FileNotFoundException)
            {
                return null;
            }
            catch (DirectoryNotFoundException)
            {
                return null;
            }
            string root;
            if (!PlanParser.KeyValues(text).TryGetValue("ROOT", out root) || root.Length == 0) return null;
            return root;
        }
    }

    // The two calls on satellite-setup.ps1, run hidden and bounded through the process runner.
    internal sealed class SatelliteScript
    {
        public const int PlanTimeoutMs = 30000;
        public const int AutostartTimeoutMs = 120000;

        private readonly IProcessRunner runner;
        private readonly string powerShell;
        private readonly string scriptPath;
        private readonly Func<string, bool> fileExists;
        private readonly ILog log;

        public SatelliteScript(IProcessRunner runner, string powerShell, string scriptPath, Func<string, bool> fileExists, ILog log)
        {
            this.runner = runner;
            this.powerShell = powerShell;
            this.scriptPath = scriptPath;
            this.fileExists = fileExists;
            this.log = log;
        }

        public string ScriptPath { get { return scriptPath; } }

        public string Prefix(string root)
        {
            return "-NoProfile -ExecutionPolicy Bypass -File " + ArgumentQuoting.Quote(scriptPath) + " -Root " + ArgumentQuoting.Quote(root);
        }

        public SatellitePlan ReadPlan(string root)
        {
            if (!fileExists(scriptPath))
            {
                log.Write("plan: " + scriptPath + " is missing");
                return SatellitePlan.Failed("satellite-setup.ps1 is missing from the program folder");
            }
            if (root.IndexOf('"') >= 0)
                return SatellitePlan.Failed("the satellite folder in the state file holds a quote character");
            ProcessResult result = runner.Run(powerShell, Prefix(root) + " -ShowPlan", PlanTimeoutMs);
            SatellitePlan plan = PlanParser.Parse(result);
            log.Write("plan: root=" + root + " exit=" + (result.Started ? result.ExitCode.ToString() : "not-started") + " kind=" + plan.Kind
                + (plan.Kind == PlanKind.Existing ? " container=" + plan.Container + " port=" + plan.Port + " autostart=" + (plan.AutostartOn ? "on" : "off") + " name=" + plan.Name : "")
                + (plan.Kind == PlanKind.Error ? " error=" + plan.Error : "") + " in " + result.ElapsedMs + " ms");
            return plan;
        }

        // satellite-setup.ps1 -Root R -Autostart on|off -NoPrompt. Returns the script's reason when it refuses.
        public CommandOutcome SetAutostart(string root, bool on)
        {
            if (!fileExists(scriptPath)) return CommandOutcome.Fail("satellite-setup.ps1 is missing from the program folder");
            if (root.IndexOf('"') >= 0) return CommandOutcome.Fail("the satellite folder in the state file holds a quote character");
            ProcessResult result = runner.Run(powerShell, Prefix(root) + " -Autostart " + (on ? "on" : "off") + " -NoPrompt", AutostartTimeoutMs);
            CommandOutcome outcome;
            if (!result.Started) outcome = CommandOutcome.Fail(result.StartError);
            else if (result.TimedOut) outcome = CommandOutcome.Fail("the setup script did not finish within " + (AutostartTimeoutMs / 1000) + " seconds");
            else if (result.ExitCode == 0) outcome = CommandOutcome.Success();
            else
            {
                string reason = PlanParser.ErrorLine(result.Stdout) ?? PlanParser.ErrorLine(result.Stderr)
                    ?? PlanParser.LastLine(result.Stdout) ?? PlanParser.LastLine(result.Stderr)
                    ?? "the setup script stopped with exit code " + result.ExitCode;
                outcome = CommandOutcome.Fail(reason);
            }
            log.Write("autostart " + (on ? "on" : "off") + ": ok=" + outcome.Ok + (outcome.Ok ? "" : " reason=" + outcome.Reason) + " in " + result.ElapsedMs + " ms");
            return outcome;
        }
    }

    internal sealed class CommandOutcome
    {
        public bool Ok;
        public string Reason = "";

        public static CommandOutcome Success()
        {
            return new CommandOutcome { Ok = true };
        }

        public static CommandOutcome Fail(string reason)
        {
            return new CommandOutcome { Ok = false, Reason = reason };
        }
    }
}
