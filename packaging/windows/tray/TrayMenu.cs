namespace VocalisSatelliteTray
{
    // What the notification-area menu holds, in the order it holds it, and when each item can be chosen. TrayContext builds
    // its window items from this list and asks IsEnabled when the state changes, so the unit tests can check the order,
    // the words and the rules without a window.
    internal enum MenuEntry
    {
        Separator,
        Status,
        Start,
        Stop,
        Autostart,
        Certificate,
        Secret,
        NewCertificate,
        Repair,
        SetupLog,
        TailLog,
        Guide,
        Exit
    }

    internal static class TrayMenu
    {
        // "Tail the satellite log" (October 11, 2026; Doug: "Give me an option that says tail the satellite log"), directly
        // below "Open the setup log".
        public const string TailLogText = "Tail the satellite log";

        public static readonly MenuEntry[] Layout =
        {
            MenuEntry.Status, MenuEntry.Separator,
            MenuEntry.Start, MenuEntry.Stop, MenuEntry.Autostart, MenuEntry.Separator,
            MenuEntry.Certificate, MenuEntry.Secret, MenuEntry.NewCertificate, MenuEntry.Repair, MenuEntry.SetupLog, MenuEntry.TailLog, MenuEntry.Guide,
            MenuEntry.Separator,
            MenuEntry.Exit
        };

        // The words of an item. The status line has none of its own: it shows TrayState.MenuLine.
        public static string Text(MenuEntry entry)
        {
            switch (entry)
            {
                case MenuEntry.Start: return "Start satellite";
                case MenuEntry.Stop: return "Stop satellite";
                case MenuEntry.Autostart: return "Start the satellite when Windows starts";
                case MenuEntry.Certificate: return "Show certificate file";
                case MenuEntry.Secret: return "Change secret…";
                case MenuEntry.NewCertificate: return "New certificate…";
                case MenuEntry.Repair: return "Repair…";
                case MenuEntry.SetupLog: return "Open the setup log";
                case MenuEntry.TailLog: return TailLogText;
                case MenuEntry.Guide: return "Satellite guide";
                // Not plain "Exit": October 11, 2026, Doug chose Exit, took it to stop the satellite, and looked for the
                // satellite's "exiting" line in its log. This item only closes the icon.
                case MenuEntry.Exit: return "Close this icon (the satellite keeps running)";
                default: return "";
            }
        }

        public static bool IsEnabled(MenuEntry entry, TrayState state)
        {
            switch (entry)
            {
                case MenuEntry.Start: return state.CanStart;
                case MenuEntry.Stop: return state.CanStop;
                case MenuEntry.Autostart: return state.AutostartEnabled;
                case MenuEntry.Certificate: return state.ShowCertificateEnabled;
                case MenuEntry.Secret:
                case MenuEntry.NewCertificate:
                case MenuEntry.SetupLog:
                    return state.SatelliteItemsEnabled;
                // The log viewer follows a file by name, so it needs the satellite's folder and nothing else: not Docker, not a
                // running container. The same condition as "Open the setup log".
                case MenuEntry.TailLog: return state.TailLogEnabled;
                case MenuEntry.Repair: return state.RepairEnabled;
                case MenuEntry.Guide: return state.GuideEnabled;
                default: return true;
            }
        }
    }
}
