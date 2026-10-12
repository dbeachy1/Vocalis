using System;
using System.Collections.Concurrent;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;

namespace VocalisSatelliteTray
{
    // The three notification-area looks, embedded in the program as resources so it shows the right picture without the
    // loose .ico files (Doug, October 11, 2026: "Don't forget to use the correct icon in the setup and the system tray").
    internal static class TrayIcons
    {
        public const string Colour = "vocalis.ico";
        public const string Stopped = "vocalis-satellite-stopped.ico";
        public const string NoDocker = "vocalis-satellite-nodocker.ico";

        public static string ResourceFor(IconLook look)
        {
            switch (look)
            {
                case IconLook.Colour: return Colour;
                case IconLook.GreyWithMark: return NoDocker;
                default: return Stopped;
            }
        }

        // The frame closest to the notification area's icon size (16 pixels at 100 percent scale, more on a scaled display).
        public static Icon Load(string resourceName, Size size)
        {
            using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName))
            {
                if (stream == null) throw new InvalidOperationException("The icon resource " + resourceName + " is not embedded in the program.");
                return new Icon(stream, size);
            }
        }
    }

    // One thread that runs the slow calls (docker, the setup script) in order, so none of them ever runs on the
    // user-interface thread.
    internal sealed class SerialWorker : IDisposable
    {
        private readonly BlockingCollection<Action> queue = new BlockingCollection<Action>();
        private readonly Thread thread;
        private readonly ILog log;

        public SerialWorker(ILog log)
        {
            this.log = log;
            thread = new Thread(Loop) { IsBackground = true, Name = "satellite tray worker" };
            thread.Start();
        }

        public void Post(Action work)
        {
            if (!queue.IsAddingCompleted) queue.Add(work);
        }

        private void Loop()
        {
            foreach (Action work in queue.GetConsumingEnumerable())
            {
                try
                {
                    work();
                }
                catch (Exception ex)
                {
                    // One failed piece of work must not stop the icon's later work; the failure is in the log.
                    log.Write("worker: unexpected failure: " + ex);
                }
            }
        }

        public void Dispose()
        {
            queue.CompleteAdding();
        }
    }

    // The notification-area icon and its menu. Everything that decides anything is in SatelliteController and TrayState;
    // this only draws them and passes clicks on.
    internal sealed class TrayContext : ApplicationContext
    {
        private const int PollMs = 15000;

        private readonly SatelliteController controller;
        private readonly IShell shell;
        private readonly string exeFolder;
        private readonly ILog log;
        private readonly SerialWorker worker;
        // SynchronizationContext.Current is still null in this constructor (Application.Run installs it later; the
        // feasibility probe of October 11, 2026 crashed with a NullReferenceException on the thread-pool thread that way).
        // A control whose handle is created here, on the user-interface thread, can marshal back to it instead.
        private readonly Control sink;
        private readonly NotifyIcon icon;
        private readonly ContextMenuStrip menu;
        private readonly System.Windows.Forms.Timer poll;
        private readonly Icon[] icons = new Icon[3];
        private readonly ControlServer server;

        // The items, made from TrayMenu.Layout (the order and the words are there, where the unit tests can see them).
        private readonly ToolStripLabel statusLine = new ToolStripLabel();
        private readonly System.Collections.Generic.Dictionary<MenuEntry, ToolStripMenuItem> entries = new System.Collections.Generic.Dictionary<MenuEntry, ToolStripMenuItem>();
        private ToolStripMenuItem Entry(MenuEntry entry) { return entries[entry]; }

        private TrayState shown = TrayState.Initial();
        private string shownSignature;
        private int refreshQueued;
        private int exiting;

        public TrayContext(SatelliteController controller, IShell shell, string exeFolder, InstanceNames names, ILog log)
        {
            this.controller = controller;
            this.shell = shell;
            this.exeFolder = exeFolder;
            this.log = log;

            sink = new Control();
            IntPtr handle = sink.Handle;
            log.Write("marshaling control handle created: " + (handle != IntPtr.Zero));

            Size small = SystemInformation.SmallIconSize;
            icons[(int)IconLook.Colour] = TrayIcons.Load(TrayIcons.Colour, small);
            icons[(int)IconLook.Grey] = TrayIcons.Load(TrayIcons.Stopped, small);
            icons[(int)IconLook.GreyWithMark] = TrayIcons.Load(TrayIcons.NoDocker, small);
            log.Write("icons loaded at " + small.Width + "x" + small.Height);

            statusLine.Font = new Font(statusLine.Font, FontStyle.Bold);
            menu = new ContextMenuStrip();
            foreach (MenuEntry entry in TrayMenu.Layout)
            {
                if (entry == MenuEntry.Separator) { menu.Items.Add(new ToolStripSeparator()); continue; }
                if (entry == MenuEntry.Status) { menu.Items.Add(statusLine); continue; }
                var item = new ToolStripMenuItem(TrayMenu.Text(entry)) { CheckOnClick = false };
                entries[entry] = item;
                menu.Items.Add(item);
            }
            menu.Opening += (s, e) => RequestRefresh("menu opened");
            Entry(MenuEntry.Start).Click += (s, e) => OnStart();
            Entry(MenuEntry.Stop).Click += (s, e) => OnCommand("stop", () => controller.Stop());
            Entry(MenuEntry.Autostart).Click += (s, e) =>
            {
                bool turnOn = !shown.AutostartOn;
                OnCommand(turnOn ? "autostart-on" : "autostart-off", () => controller.SetAutostart(turnOn));
            };
            Entry(MenuEntry.Certificate).Click += (s, e) => ShellCommands.ShowCertificate(shell, shown.CertificateFile, Failed);
            Entry(MenuEntry.Secret).Click += (s, e) => ShellCommands.RunSetup(shell, exeFolder, "newsecret", Failed);
            Entry(MenuEntry.NewCertificate).Click += (s, e) => ShellCommands.RunSetup(shell, exeFolder, "newcertificate", Failed);
            Entry(MenuEntry.Repair).Click += (s, e) => ShellCommands.RunSetup(shell, exeFolder, "repair", Failed);
            Entry(MenuEntry.SetupLog).Click += (s, e) => ShellCommands.OpenSetupLog(shell, shown.Root, Failed);
            Entry(MenuEntry.TailLog).Click += (s, e) =>
            {
                // A window of its own that outlives the satellite's restarts and this icon; the shell logs its process id.
                log.Write("menu: " + TrayMenu.TailLogText + " chosen: following " + (string.IsNullOrEmpty(shown.Root) ? "(no folder)" : ShellCommands.LogPath(shown.Root)));
                ShellCommands.TailLog(shell, exeFolder, shown.Root, ShellCommands.PowerShellPath(), Failed);
            };
            Entry(MenuEntry.Guide).Click += (s, e) => ShellCommands.OpenGuide(shell, exeFolder, Failed);
            Entry(MenuEntry.Exit).Click += (s, e) => { log.Write("menu: Exit chosen (the satellite is left as it is)"); ExitThread(); };

            icon = new NotifyIcon { ContextMenuStrip = menu, Icon = icons[(int)IconLook.Grey], Text = shown.Tooltip, Visible = true };
            Apply(shown);
            log.Write("tray icon created, Visible=" + icon.Visible + ", menu items=" + menu.Items.Count);

            worker = new SerialWorker(log);
            controller.StateChanged += state => PostToUi(() => Apply(state));

            var handler = new ControlRequestHandler(controller, () => PostToUi(ExitThread), log);
            server = new ControlServer(names.Pipe, handler.Handle, log);
            server.Start();

            poll = new System.Windows.Forms.Timer { Interval = PollMs };
            poll.Tick += (s, e) => RequestRefresh("poll");
            poll.Start();
            RequestRefresh("start");
        }

        // The slow part of a refresh runs on the worker; at most one is waiting at a time.
        private void RequestRefresh(string why)
        {
            if (Interlocked.CompareExchange(ref refreshQueued, 1, 0) != 0) return;
            worker.Post(() =>
            {
                Interlocked.Exchange(ref refreshQueued, 0);
                controller.Refresh(why);
            });
        }

        // Start on a missing container opens Repair (design: "Start then opens Repair").
        private void OnStart()
        {
            if (shown.StartOpensRepair)
            {
                log.Write("menu: Start chosen while the container is missing: opening Repair");
                ShellCommands.RunSetup(shell, exeFolder, "repair", Failed);
                return;
            }
            OnCommand("start", () => controller.Start());
        }

        private void OnCommand(string name, Func<CommandOutcome> command)
        {
            log.Write("menu: " + name + " chosen");
            worker.Post(() =>
            {
                CommandOutcome outcome = command();
                if (!outcome.Ok) PostToUi(() => Balloon(outcome.Reason));
            });
        }

        private void Failed(string reason)
        {
            // The controller's lock can be held by a docker call that takes a minute, so the note goes through the worker.
            worker.Post(() => controller.NoteFailure(reason));
            Balloon(reason);
        }

        private void Balloon(string text)
        {
            if (text.Length > 250) text = text.Substring(0, 247) + "...";
            icon.ShowBalloonTip(5000, "Vocalis satellite", text, ToolTipIcon.Warning);
        }

        private void PostToUi(Action action)
        {
            try
            {
                if (!sink.IsDisposed && sink.IsHandleCreated) sink.BeginInvoke(action);
            }
            catch (InvalidOperationException ex)
            {
                // Also covers ObjectDisposedException: the icon is closing or closed.
                log.Write("could not marshal to the user-interface thread (the icon is closing): " + ex.Message);
            }
        }

        private void Apply(TrayState state)
        {
            shown = state;
            if (state.Signature == shownSignature) return;
            shownSignature = state.Signature;
            icon.Icon = icons[(int)state.Look];
            icon.Text = state.Tooltip;
            statusLine.Text = state.MenuLine;
            foreach (var pair in entries) pair.Value.Enabled = TrayMenu.IsEnabled(pair.Key, state);
            Entry(MenuEntry.Autostart).Checked = state.HasSatellite && state.AutostartOn;
            log.Write("shown: " + state.Situation + " look=" + state.Look + " tooltip=\"" + state.Tooltip + "\"");
        }

        protected override void ExitThreadCore()
        {
            if (Interlocked.Exchange(ref exiting, 1) != 0) return;
            log.Write("ExitThreadCore: removing the icon");
            poll.Stop();
            poll.Dispose();
            server.Dispose();
            worker.Dispose();
            icon.Visible = false;
            icon.Dispose();
            menu.Dispose();
            foreach (Icon item in icons) item.Dispose();
            sink.Dispose();
            base.ExitThreadCore();
            log.Write("ExitThreadCore: done");
        }
    }
}
