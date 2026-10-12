using System;

namespace VocalisSatelliteTray
{
    internal enum ContainerState
    {
        Running,
        Starting,     // Docker reports it restarting
        Stopped,      // created, exited, paused, dead, removing: not running
        Missing,      // Docker answers and has no such container
        DockerDown    // Docker did not answer: Docker Desktop is not running (or docker.exe is not there)
    }

    internal sealed class DockerStatus
    {
        public ContainerState State;
        public string Detail = "";
    }

    // docker.exe from PATH, three calls only: container inspect, start, stop. Each bounded; the caller keeps them off
    // the user-interface thread. No "docker events": polling needs no restart logic and leaves no orphaned docker.exe
    // when the icon is killed (design, October 11, 2026).
    internal sealed class DockerCli
    {
        public const int InspectTimeoutMs = 10000;
        public const int StartTimeoutMs = 60000;
        public const int StopTimeoutMs = 90000;
        // One format string, quoted so that a command prompt (a stand-in docker.cmd in the tests) does not read the
        // braces or the space as syntax. The answer is "<status> <restarting>", for example "running false".
        public const string InspectFormat = "\"{{.State.Status}} {{.State.Restarting}}\"";

        private readonly IProcessRunner runner;
        private readonly ILog log;

        public DockerCli(IProcessRunner runner, ILog log)
        {
            this.runner = runner;
            this.log = log;
        }

        public DockerStatus Inspect(string container)
        {
            ProcessResult result = runner.Run("docker", "container inspect --format " + InspectFormat + " " + container, InspectTimeoutMs);
            DockerStatus status = ParseInspect(result);
            log.Write("inspect " + container + ": " + status.State + (status.Detail.Length > 0 ? " (" + status.Detail + ")" : "") + " in " + result.ElapsedMs + " ms");
            return status;
        }

        public CommandOutcome Start(string container)
        {
            return Command("start", container, StartTimeoutMs);
        }

        public CommandOutcome Stop(string container)
        {
            return Command("stop", container, StopTimeoutMs);
        }

        private CommandOutcome Command(string verb, string container, int timeoutMs)
        {
            ProcessResult result = runner.Run("docker", verb + " " + container, timeoutMs);
            CommandOutcome outcome;
            if (!result.Started) outcome = CommandOutcome.Fail("docker could not be run: " + result.StartError);
            else if (result.TimedOut) outcome = CommandOutcome.Fail("docker " + verb + " did not finish within " + (timeoutMs / 1000) + " seconds");
            else if (result.ExitCode == 0) outcome = CommandOutcome.Success();
            else outcome = CommandOutcome.Fail(DockerReason(result, "docker " + verb + " failed with exit code " + result.ExitCode));
            log.Write("docker " + verb + " " + container + ": ok=" + outcome.Ok + (outcome.Ok ? "" : " reason=" + outcome.Reason) + " in " + result.ElapsedMs + " ms");
            return outcome;
        }

        // "Error response from daemon: <text>" is Docker's own wording and is kept; only the first line is used.
        public static string DockerReason(ProcessResult result, string fallback)
        {
            string line = FirstLine(result.Stderr) ?? FirstLine(result.Stdout);
            if (line == null) return fallback;
            return line.Length > 240 ? line.Substring(0, 237) + "..." : line;
        }

        private static string FirstLine(string text)
        {
            foreach (string raw in (text ?? "").Split('\n'))
                if (raw.Trim().Length > 0) return raw.Trim();
            return null;
        }

        public static DockerStatus ParseInspect(ProcessResult result)
        {
            if (!result.Started) return new DockerStatus { State = ContainerState.DockerDown, Detail = result.StartError };
            if (result.TimedOut) return new DockerStatus { State = ContainerState.DockerDown, Detail = "docker did not answer in time" };
            if (result.ExitCode != 0)
            {
                string text = ((result.Stderr ?? "") + "\n" + (result.Stdout ?? "")).ToLowerInvariant();
                if (text.Contains("no such container") || text.Contains("no such object"))
                    return new DockerStatus { State = ContainerState.Missing };
                return new DockerStatus { State = ContainerState.DockerDown, Detail = DockerReason(result, "docker exit code " + result.ExitCode) };
            }
            string[] parts = (result.Stdout ?? "").Trim().Split(new[] { ' ', '\t', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 2) return new DockerStatus { State = ContainerState.DockerDown, Detail = "unexpected inspect output: " + (result.Stdout ?? "").Trim() };
            string status = parts[0].ToLowerInvariant();
            bool restarting = parts[1].ToLowerInvariant() == "true";
            if (status == "restarting" || restarting) return new DockerStatus { State = ContainerState.Starting };
            if (status == "running") return new DockerStatus { State = ContainerState.Running };
            return new DockerStatus { State = ContainerState.Stopped, Detail = status };
        }
    }
}
