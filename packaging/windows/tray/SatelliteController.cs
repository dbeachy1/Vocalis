using System;

namespace VocalisSatelliteTray
{
    // The icon's brain, with no window: it keeps the state the window shows, asks Docker and the setup script for facts,
    // and runs the commands. Every public method is serialized by one lock and is meant to be called off the
    // user-interface thread. The window only subscribes to StateChanged.
    //
    // What it never does: read satellite.env, the pairing secret or the private key (facts come from the plan, which is
    // the setup script's own -ShowPlan); create or change a container (Start and Stop are plain docker start and stop;
    // the autostart setting goes through the setup script).
    internal sealed class SatelliteController
    {
        private readonly object gate = new object();
        private readonly DockerCli docker;
        private readonly SatelliteScript script;
        private readonly IStateFile stateFile;
        private readonly Func<bool> dockerDesktopStartsAtSignIn;
        private readonly ILog log;

        private bool signInStartPending;
        private SatellitePlan plan;
        private string root;
        private string planStamp;
        private string lastError = "";
        private Situation lastErrorSituation;
        private TrayState state = TrayState.Initial();

        public event Action<TrayState> StateChanged;

        // signIn is true only when the icon was started with --signin: then, and only then, the satellite is started once
        // Docker answers, if the recorded setting is on and it is not already running (design, "Start with Windows, made true").
        public SatelliteController(DockerCli docker, SatelliteScript script, IStateFile stateFile, Func<bool> dockerDesktopStartsAtSignIn, ILog log, bool signIn)
        {
            this.docker = docker;
            this.script = script;
            this.stateFile = stateFile;
            this.dockerDesktopStartsAtSignIn = dockerDesktopStartsAtSignIn;
            this.log = log;
            signInStartPending = signIn;
            log.Write("controller: sign-in start " + (signIn ? "armed (started with --signin)" : "not armed (not started with --signin)"));
        }

        public TrayState State
        {
            get { lock (gate) return state; }
        }

        // Reads the plan when it has to (first time, the state file changed, or the last answer was not a usable
        // satellite), asks Docker, works out the state, and applies the sign-in rule.
        public TrayState Refresh(string why)
        {
            TrayState snapshot;
            lock (gate)
            {
                log.Write("refresh: " + why);
                snapshot = RefreshCore(null);
            }
            Notify(snapshot);
            return snapshot;
        }

        public CommandOutcome Start()
        {
            return Run("start", false);
        }

        public CommandOutcome Stop()
        {
            return Run("stop", false);
        }

        public CommandOutcome SetAutostart(bool on)
        {
            return Run(on ? "autostart-on" : "autostart-off", false);
        }

        // The command line's "--do": the same commands, after a fresh look at Docker, so a stale picture cannot decide.
        public CommandOutcome Execute(string verb)
        {
            return Run(verb, true);
        }

        // A failure outside the controller's own commands (a shell action that could not start) that should still show
        // as the last failed command's reason on the first menu line. It asks nobody anything (it is called from the
        // user-interface thread): the situation shown stays the one last observed.
        public void NoteFailure(string reason)
        {
            TrayState snapshot;
            lock (gate)
            {
                log.Write("failure noted: " + reason);
                lastError = reason;
                lastErrorSituation = state.Situation;
                state = state.WithLastError(reason);
                snapshot = state;
            }
            Notify(snapshot);
        }

        private CommandOutcome Run(string verb, bool refreshFirst)
        {
            TrayState snapshot;
            CommandOutcome outcome;
            var watch = System.Diagnostics.Stopwatch.StartNew();
            lock (gate)
            {
                lastError = "";
                if (refreshFirst) RefreshCore(null);
                log.Write("command " + verb + ": situation=" + state.Situation + " container=" + state.Container);
                outcome = Dispatch(verb);
                string error = outcome.Ok ? null : (CommandTitle(verb) + " failed: " + outcome.Reason);
                // The state shown after any command, failed or not, is the one Docker reports right after it, so a failed
                // call can never leave a state on screen that is not true.
                // The autostart setting lives in the plan, so only that command reads the plan again.
                snapshot = RefreshCore(error, verb == "autostart-on" || verb == "autostart-off");
                log.Write("command " + verb + ": ok=" + outcome.Ok + (outcome.Ok ? "" : " reason=" + outcome.Reason) + " now " + snapshot.Situation + " in " + watch.ElapsedMilliseconds + " ms");
            }
            Notify(snapshot);
            return outcome;
        }

        private static string CommandTitle(string verb)
        {
            switch (verb)
            {
                case "start": return "Start";
                case "stop": return "Stop";
                default: return "Changing the autostart setting";
            }
        }

        private CommandOutcome Dispatch(string verb)
        {
            TrayState s = state;
            switch (verb)
            {
                case "start":
                    if (s.Situation == Situation.Running || s.Situation == Situation.Starting)
                    {
                        log.Write("start: nothing to do, the satellite is " + s.Situation);
                        return CommandOutcome.Success();
                    }
                    if (s.Situation == Situation.ContainerMissing) return CommandOutcome.Fail("the satellite's container is missing; choose Repair");
                    if (s.Situation != Situation.Stopped) return CommandOutcome.Fail(NotAvailable(s));
                    return docker.Start(s.Container);
                case "stop":
                    if (s.Situation == Situation.Stopped)
                    {
                        log.Write("stop: nothing to do, the satellite is already stopped");
                        return CommandOutcome.Success();
                    }
                    if (s.Situation != Situation.Running && s.Situation != Situation.Starting) return CommandOutcome.Fail(NotAvailable(s));
                    return docker.Stop(s.Container);
                case "autostart-on":
                case "autostart-off":
                    if (!s.AutostartEnabled) return CommandOutcome.Fail(NotAvailable(s));
                    return script.SetAutostart(s.Root, verb == "autostart-on");
                default:
                    return CommandOutcome.Fail("unknown command \"" + verb + "\"");
            }
        }

        private static string NotAvailable(TrayState s)
        {
            switch (s.Situation)
            {
                case Situation.DockerNotRunning: return "Docker Desktop is not running";
                case Situation.NoSatellite: return "no satellite is set up";
                case Situation.FolderUnreadable: return "the satellite folder cannot be read: " + s.PlanError;
                case Situation.ContainerMissing: return "the satellite's container is missing; choose Repair";
                default: return "the satellite is not ready yet";
            }
        }

        // The refresh itself. forcePlan makes it read the plan again (after the autostart setting changed). newError, when
        // given, becomes the last failed command's reason, tied to the situation it was reported in.
        private TrayState RefreshCore(string newError, bool forcePlan = false)
        {
            string stamp = stateFile.Stamp();
            bool reload = forcePlan || plan == null || stamp != planStamp || plan.Kind != PlanKind.Existing;
            if (reload)
            {
                string newRoot = stateFile.ReadRoot();
                root = newRoot;
                if (newRoot == null)
                {
                    plan = SatellitePlan.None();
                    log.Write("plan: no ROOT in the state file (" + stamp + "): no satellite is set up");
                }
                else
                {
                    plan = script.ReadPlan(newRoot);
                }
                planStamp = stamp;
            }

            DockerStatus status = null;
            if (plan.Kind == PlanKind.Existing) status = docker.Inspect(plan.Container);
            TrayState built = TrayState.Build(root, plan, status, dockerDesktopStartsAtSignIn(), lastError);

            if (plan.Kind == PlanKind.Existing && signInStartPending && status.State != ContainerState.DockerDown)
            {
                // Docker answered, so this is the once-per-sign-in moment, whatever happens next.
                signInStartPending = false;
                if (plan.AutostartOn && status.State == ContainerState.Stopped)
                {
                    log.Write("sign-in start: Docker answered, the satellite is stopped and autostart is on: starting " + plan.Container);
                    CommandOutcome outcome = docker.Start(plan.Container);
                    if (!outcome.Ok) newError = "Starting the satellite at sign-in failed: " + outcome.Reason;
                    status = docker.Inspect(plan.Container);
                    built = TrayState.Build(root, plan, status, dockerDesktopStartsAtSignIn(), lastError);
                }
                else
                {
                    log.Write("sign-in start: not needed (satellite " + status.State + ", autostart " + (plan.AutostartOn ? "on" : "off") + ")");
                }
            }

            if (newError != null)
            {
                lastError = newError;
                lastErrorSituation = built.Situation;
            }
            else if (lastError.Length > 0 && lastErrorSituation != built.Situation)
            {
                log.Write("last error cleared: the situation changed from " + lastErrorSituation + " to " + built.Situation);
                lastError = "";
            }
            built = built.WithLastError(lastError);

            if (built.Situation != state.Situation)
                log.Write("state: " + state.Situation + " -> " + built.Situation + " (container=" + built.Container + " port=" + built.Port + " autostart=" + (built.AutostartOn ? "on" : "off") + ")");
            state = built;
            return built;
        }

        private void Notify(TrayState snapshot)
        {
            Action<TrayState> handler = StateChanged;
            if (handler != null) handler(snapshot);
        }
    }
}
