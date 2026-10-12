using System;
using System.Text;

namespace VocalisSatelliteTray
{
    // The situations the icon tells apart, each as the menu's first line (design, "The situations it tells apart").
    internal enum Situation
    {
        Checking,           // before the first answer only
        Running,
        Stopped,
        Starting,
        DockerNotRunning,
        ContainerMissing,
        NoSatellite,
        FolderUnreadable
    }

    // Colour (running), grey (stopped, starting, or nothing to run), grey with a small mark (Docker Desktop is not running).
    internal enum IconLook
    {
        Colour,
        Grey,
        GreyWithMark
    }

    // Everything the window shows, worked out from the plan, Docker's answer and the last failed command, with no
    // window involved. Immutable; two states with the same Signature look identical.
    internal sealed class TrayState
    {
        // Windows' limit for a notification-area tooltip is 63 characters (NotifyIcon.Text throws above it).
        public const int TooltipLimit = 63;
        public const int MenuLineLimit = 240;

        public Situation Situation;
        public string Root = "";
        public string Name = "";
        public int Port;
        public string Container = "";
        public bool AutostartOn;
        public bool DockerDesktopStartsAtSignIn = true;
        public string PlanError = "";
        public string LastError = "";
        public string CertificateFile = "";

        public static TrayState Initial()
        {
            return new TrayState { Situation = Situation.Checking };
        }

        public static TrayState Build(string root, SatellitePlan plan, DockerStatus docker, bool dockerDesktopStartsAtSignIn, string lastError)
        {
            var state = new TrayState { Root = root ?? "", DockerDesktopStartsAtSignIn = dockerDesktopStartsAtSignIn, LastError = lastError ?? "" };
            if (plan == null) { state.Situation = Situation.Checking; return state; }
            if (plan.Kind == PlanKind.New) { state.Situation = Situation.NoSatellite; return state; }
            if (plan.Kind == PlanKind.Error)
            {
                state.Situation = Situation.FolderUnreadable;
                state.PlanError = plan.Error;
                return state;
            }
            state.Name = plan.Name;
            state.Port = plan.Port;
            state.Container = plan.Container;
            state.AutostartOn = plan.AutostartOn;
            state.CertificateFile = plan.CertificateFile;
            switch (docker == null ? ContainerState.DockerDown : docker.State)
            {
                case ContainerState.Running: state.Situation = Situation.Running; break;
                case ContainerState.Starting: state.Situation = Situation.Starting; break;
                case ContainerState.Stopped: state.Situation = Situation.Stopped; break;
                case ContainerState.Missing: state.Situation = Situation.ContainerMissing; break;
                default: state.Situation = Situation.DockerNotRunning; break;
            }
            return state;
        }

        public TrayState WithLastError(string lastError)
        {
            var copy = (TrayState)MemberwiseClone();
            copy.LastError = lastError ?? "";
            return copy;
        }

        public bool HasSatellite
        {
            get
            {
                return Situation == Situation.Running || Situation == Situation.Stopped || Situation == Situation.Starting
                    || Situation == Situation.DockerNotRunning || Situation == Situation.ContainerMissing;
            }
        }

        public IconLook Look
        {
            get
            {
                if (Situation == Situation.Running) return IconLook.Colour;
                if (Situation == Situation.DockerNotRunning) return IconLook.GreyWithMark;
                return IconLook.Grey;
            }
        }

        // The menu's first line, then the last failed command's reason after it (Windows can be set to hide balloons).
        public string MenuLine
        {
            get
            {
                string line = Describe();
                if (LastError.Length > 0) line += " - " + LastError;
                line = Flatten(line);
                return line.Length > MenuLineLimit ? line.Substring(0, MenuLineLimit - 3) + "..." : line;
            }
        }

        private string Describe()
        {
            switch (Situation)
            {
                case Situation.Running: return "Running on port " + Port;
                case Situation.Stopped: return "Stopped";
                case Situation.Starting: return "Starting (Docker reports it restarting)";
                case Situation.DockerNotRunning:
                    return "Docker Desktop is not running" + (DockerDesktopStartsAtSignIn ? "" : " and is not set to start when you sign in");
                case Situation.ContainerMissing: return "The satellite's container is missing: choose Repair";
                case Situation.NoSatellite: return "No satellite is set up";
                case Situation.FolderUnreadable: return "The satellite folder cannot be read: " + PlanError;
                default: return "Checking the satellite...";
            }
        }

        private string ShortStatus()
        {
            switch (Situation)
            {
                case Situation.Running: return "running";
                case Situation.Stopped: return "stopped";
                case Situation.Starting: return "starting";
                case Situation.DockerNotRunning: return "Docker Desktop is not running";
                case Situation.ContainerMissing: return "container missing";
                case Situation.NoSatellite: return "not set up";
                case Situation.FolderUnreadable: return "folder unreadable";
                default: return "checking";
            }
        }

        // The satellite's name and port and which situation it is in, never longer than 63 characters: a long name is
        // shortened first so the situation stays readable.
        public string Tooltip
        {
            get
            {
                string status = ShortStatus();
                if (!HasSatellite) return Cut("Vocalis satellite: " + status);
                string tail = ", port " + Port + ": " + status;
                string head = "Vocalis satellite ";
                int room = TooltipLimit - head.Length - tail.Length;
                string name = Flatten(Name);
                if (name.Length > room) name = room >= 4 ? name.Substring(0, room - 3) + "..." : "";
                string text = name.Length > 0 ? head + name + tail : "Vocalis satellite" + tail;
                return Cut(text);
            }
        }

        private static string Cut(string text)
        {
            return text.Length > TooltipLimit ? text.Substring(0, TooltipLimit) : text;
        }

        private static string Flatten(string text)
        {
            var sb = new StringBuilder();
            foreach (char c in text ?? "") sb.Append(char.IsControl(c) ? ' ' : c);
            return sb.ToString().Trim();
        }

        // The first menu line is also where Start finds out what it should do.
        public bool CanStart { get { return Situation == Situation.Stopped || Situation == Situation.ContainerMissing; } }
        public bool StartOpensRepair { get { return Situation == Situation.ContainerMissing; } }
        public bool CanStop { get { return Situation == Situation.Running || Situation == Situation.Starting; } }
        // Greyed while Docker is not running: the script refuses then and records nothing.
        public bool AutostartEnabled { get { return HasSatellite && Situation != Situation.DockerNotRunning; } }
        public bool ShowCertificateEnabled { get { return HasSatellite && CertificateFile.Length > 0; } }
        public bool SatelliteItemsEnabled { get { return HasSatellite; } }
        // Whenever the satellite's folder is known, like "Open the setup log"; the viewer follows a file, so Docker is not needed.
        public bool TailLogEnabled { get { return HasSatellite; } }
        // No satellite: Repair and Exit only. A folder that cannot be read: Repair, the guide and Exit.
        public bool RepairEnabled { get { return true; } }
        public bool GuideEnabled { get { return Situation != Situation.NoSatellite; } }

        // Two states with the same signature look the same, so the window only redraws on a change.
        public string Signature
        {
            get
            {
                return string.Join("|", new[]
                {
                    Situation.ToString(), Name, Port.ToString(), AutostartOn.ToString(), DockerDesktopStartsAtSignIn.ToString(),
                    PlanError, LastError, CertificateFile, Root
                });
            }
        }
    }
}
