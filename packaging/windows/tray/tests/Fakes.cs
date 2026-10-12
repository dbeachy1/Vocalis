using System;
using System.Collections.Generic;

namespace VocalisSatelliteTray.Tests
{
    // The stand-in for docker.exe and powershell.exe: every call is recorded as "<file> <arguments>", and each answer
    // comes from the first rule whose text the call contains.
    internal sealed class FakeRunner : IProcessRunner
    {
        private readonly List<KeyValuePair<string, Func<ProcessResult>>> rules = new List<KeyValuePair<string, Func<ProcessResult>>>();
        public readonly List<string> Calls = new List<string>();
        public readonly List<int> Timeouts = new List<int>();

        public void On(string contains, ProcessResult result)
        {
            rules.Insert(0, new KeyValuePair<string, Func<ProcessResult>>(contains, () => result));
        }

        public void On(string contains, Func<ProcessResult> result)
        {
            rules.Insert(0, new KeyValuePair<string, Func<ProcessResult>>(contains, result));
        }

        public ProcessResult Run(string fileName, string arguments, int timeoutMs)
        {
            string call = fileName + " " + arguments;
            Calls.Add(call);
            Timeouts.Add(timeoutMs);
            foreach (var rule in rules)
                if (call.Contains(rule.Key)) return rule.Value();
            return ProcessResult.Exited(1, "", "no rule for: " + call);
        }

        public int Count(string contains)
        {
            int n = 0;
            foreach (string call in Calls) if (call.Contains(contains)) n++;
            return n;
        }

        public void Clear()
        {
            Calls.Clear();
            Timeouts.Clear();
        }
    }

    internal sealed class ListLog : ILog
    {
        public readonly List<string> Lines = new List<string>();

        public void Write(string message)
        {
            lock (Lines) Lines.Add(message);
        }

        public bool Has(string text)
        {
            lock (Lines)
            {
                foreach (string line in Lines) if (line.Contains(text)) return true;
            }
            return false;
        }
    }

    internal sealed class FakeStateFile : IStateFile
    {
        public string Root = @"C:\sat";
        public string Version = "1";

        public string Stamp() { return Root == null ? "missing" : Version; }

        public string ReadRoot() { return Root; }
    }

    internal static class Plans
    {
        public const string Container = "vocalis-satellite-vs-abc";

        public static ProcessResult Existing(string autostart = "on", string name = "workstation", int port = 7880)
        {
            return ProcessResult.Exited(0,
                "SATELLITE=existing\nSATELLITE_ID=vs-abc\nNAME=" + name + "\nPORT=" + port + "\nCONTAINER=" + Container + "\nAUTOSTART=" + autostart
                + "\nIMAGE=vocalis-satellite@sha256:" + new string('1', 64) + "\nADDRESSES=192.168.1.5\nNEEDS_SECRET=no\nNEEDS_CERTIFICATE=no\nSETUP_FINISHED=yes"
                + "\nCERTIFICATE_FILE=C:\\sat\\data\\certs\\cert.pem\nFINGERPRINT=AB:CD\n", "");
        }

        public static ProcessResult NewSatellite()
        {
            return ProcessResult.Exited(0, "SATELLITE=new\nSATELLITE_ID=\nNAME=workstation\nPORT=7880\nCONTAINER=\nAUTOSTART=on\n", "");
        }

        public static ProcessResult Refused(string reason)
        {
            return ProcessResult.Exited(1, "ERROR: " + reason + "\n", "");
        }
    }

    internal static class Docker
    {
        public static ProcessResult Running() { return ProcessResult.Exited(0, "running false\n", ""); }
        public static ProcessResult Exited() { return ProcessResult.Exited(0, "exited false\n", ""); }
        public static ProcessResult Restarting() { return ProcessResult.Exited(0, "restarting true\n", ""); }
        public static ProcessResult Missing() { return ProcessResult.Exited(1, "", "Error: No such container: " + Plans.Container + "\n"); }
        public static ProcessResult Down()
        {
            return ProcessResult.Exited(1, "", "error during connect: Get \"http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.51/containers/x/json\": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.\n");
        }
        public static ProcessResult Ok() { return ProcessResult.Exited(0, Plans.Container + "\n", ""); }
        public static ProcessResult Refused(string text) { return ProcessResult.Exited(1, "", "Error response from daemon: " + text + "\nError: failed\n"); }
    }

    // A fake Docker whose container state changes with "docker start" and "docker stop", like the real one.
    internal sealed class Harness
    {
        public readonly FakeRunner Runner = new FakeRunner();
        public readonly ListLog Log = new ListLog();
        public readonly FakeStateFile StateFile = new FakeStateFile();
        public bool DockerDesktopAtSignIn = true;
        public SatelliteController Controller;
        public ProcessResult PlanAnswer = Plans.Existing();
        public ProcessResult ContainerAnswer = Docker.Running();
        public ProcessResult StartAnswer = Docker.Ok();
        public ProcessResult StopAnswer = Docker.Ok();
        public ProcessResult AutostartAnswer = ProcessResult.Exited(0, "", "");
        public readonly List<TrayState> Notified = new List<TrayState>();

        public Harness(bool signIn = false, ProcessResult container = null)
        {
            if (container != null) ContainerAnswer = container;
            Runner.On("-ShowPlan", () => PlanAnswer);
            Runner.On("-Autostart", () => AutostartAnswer);
            Runner.On("container inspect", () => ContainerAnswer);
            Runner.On("docker start", () => { if (StartAnswer.ExitCode == 0) ContainerAnswer = Docker.Running(); return StartAnswer; });
            Runner.On("docker stop", () => { if (StopAnswer.ExitCode == 0) ContainerAnswer = Docker.Exited(); return StopAnswer; });
            var script = new SatelliteScript(Runner, "powershell.exe", @"C:\app\satellite-setup.ps1", p => true, Log);
            Controller = new SatelliteController(new DockerCli(Runner, Log), script, StateFile, () => DockerDesktopAtSignIn, Log, signIn);
            Controller.StateChanged += s => Notified.Add(s);
        }
    }
}
