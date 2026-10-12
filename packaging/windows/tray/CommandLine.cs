using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace VocalisSatelliteTray
{
    internal enum CommandKind
    {
        RunIcon,   // no argument, or --signin
        Exit,      // --exit
        Do,        // --do start|stop|autostart-on|autostart-off
        Invalid
    }

    internal sealed class ParsedCommand
    {
        public CommandKind Kind;
        public bool SignIn;
        public string Verb;
        public string Error;
    }

    // The command line of the design: no argument shows the icon; --signin is the same plus the one start-at-sign-in
    // rule; --exit closes the running icon; --do hands one command to the running icon.
    internal static class CommandLine
    {
        public static readonly string[] Verbs = { "start", "stop", "autostart-on", "autostart-off" };

        public const string Usage = "Usage: VocalisSatelliteTray.exe [--signin | --exit | --do start|stop|autostart-on|autostart-off]";

        public static ParsedCommand Parse(string[] args)
        {
            args = args ?? new string[0];
            if (args.Length == 0) return new ParsedCommand { Kind = CommandKind.RunIcon };
            string first = args[0].ToLowerInvariant();
            if (first == "--signin")
            {
                if (args.Length == 1) return new ParsedCommand { Kind = CommandKind.RunIcon, SignIn = true };
                return Invalid("--signin takes no further argument.");
            }
            if (first == "--exit")
            {
                if (args.Length == 1) return new ParsedCommand { Kind = CommandKind.Exit };
                return Invalid("--exit takes no further argument.");
            }
            if (first == "--do")
            {
                if (args.Length != 2) return Invalid("--do needs exactly one of: " + string.Join(", ", Verbs) + ".");
                string verb = args[1].ToLowerInvariant();
                if (Array.IndexOf(Verbs, verb) < 0) return Invalid("--do: unknown command \"" + args[1] + "\"; use one of: " + string.Join(", ", Verbs) + ".");
                return new ParsedCommand { Kind = CommandKind.Do, Verb = verb };
            }
            return Invalid("Unknown argument \"" + args[0] + "\".");
        }

        private static ParsedCommand Invalid(string reason)
        {
            return new ParsedCommand { Kind = CommandKind.Invalid, Error = reason };
        }
    }

    // The mutex, and the pipe the running icon listens on, named from the program's own folder (and the user), so two
    // installs in different folders never collide and no identity ever needs passing. "Local\" keeps the mutex to this
    // sign-in session; the pipe name carries the user because pipe names are machine wide.
    internal sealed class InstanceNames
    {
        public string Mutex;
        public string Pipe;

        public static InstanceNames For(string exeFolder, string userSid)
        {
            string normal = Path.GetFullPath(exeFolder).TrimEnd('\\', '/').ToLowerInvariant();
            byte[] hash;
            using (var sha = SHA256.Create()) hash = sha.ComputeHash(Encoding.UTF8.GetBytes(normal + "|" + (userSid ?? "")));
            var hex = new StringBuilder();
            for (int i = 0; i < 8; i++) hex.Append(hash[i].ToString("x2"));
            return new InstanceNames { Mutex = "Local\\VocalisSatelliteTray." + hex + ".Mutex", Pipe = "VocalisSatelliteTray." + hex + ".Pipe" };
        }
    }
}
