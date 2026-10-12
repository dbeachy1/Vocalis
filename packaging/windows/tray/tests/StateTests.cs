using System;
using Xunit;

namespace VocalisSatelliteTray.Tests
{
    // Every situation of the design's list, worked out from plan results and Docker's answers with no window.
    public class SituationTests
    {
        private static TrayState Build(SatellitePlan plan, ContainerState? docker, bool dockerDesktopAtSignIn = true, string lastError = "")
        {
            return TrayState.Build(@"C:\sat", plan, docker.HasValue ? new DockerStatus { State = docker.Value } : null, dockerDesktopAtSignIn, lastError);
        }

        private static SatellitePlan Existing(string autostart = "on", string name = "workstation", int port = 7880)
        {
            return PlanParser.Parse(Plans.Existing(autostart, name, port));
        }

        [Fact]
        public void Running_says_the_port_and_uses_the_colour_icon()
        {
            TrayState s = Build(Existing(), ContainerState.Running);
            Assert.Equal(Situation.Running, s.Situation);
            Assert.Equal("Running on port 7880", s.MenuLine);
            Assert.Equal(IconLook.Colour, s.Look);
            Assert.False(s.CanStart);
            Assert.True(s.CanStop);
            Assert.True(s.AutostartEnabled);
        }

        [Fact]
        public void Stopped_is_grey_and_offers_start_only()
        {
            TrayState s = Build(Existing(), ContainerState.Stopped);
            Assert.Equal("Stopped", s.MenuLine);
            Assert.Equal(IconLook.Grey, s.Look);
            Assert.True(s.CanStart);
            Assert.False(s.StartOpensRepair);
            Assert.False(s.CanStop);
        }

        [Fact]
        public void Starting_is_grey_and_says_docker_reports_it_restarting()
        {
            TrayState s = Build(Existing(), ContainerState.Starting);
            Assert.Equal("Starting (Docker reports it restarting)", s.MenuLine);
            Assert.Equal(IconLook.Grey, s.Look);
            Assert.False(s.CanStart);
            Assert.True(s.CanStop);
        }

        [Fact]
        public void Docker_not_running_is_grey_with_the_mark_and_greys_the_autostart_item()
        {
            TrayState s = Build(Existing(), ContainerState.DockerDown, true);
            Assert.Equal("Docker Desktop is not running", s.MenuLine);
            Assert.Equal(IconLook.GreyWithMark, s.Look);
            Assert.False(s.CanStart);
            Assert.False(s.CanStop);
            Assert.False(s.AutostartEnabled);
            Assert.True(s.AutostartOn);
        }

        [Fact]
        public void Docker_not_running_and_not_set_to_start_at_sign_in_says_so()
        {
            TrayState s = Build(Existing(), ContainerState.DockerDown, false);
            Assert.Equal("Docker Desktop is not running and is not set to start when you sign in", s.MenuLine);
        }

        [Fact]
        public void A_missing_container_says_choose_repair_and_start_opens_repair()
        {
            TrayState s = Build(Existing(), ContainerState.Missing);
            Assert.Equal("The satellite's container is missing: choose Repair", s.MenuLine);
            Assert.Equal(IconLook.Grey, s.Look);
            Assert.True(s.CanStart);
            Assert.True(s.StartOpensRepair);
            Assert.False(s.CanStop);
        }

        [Fact]
        public void No_satellite_leaves_repair_and_exit_only()
        {
            TrayState s = Build(SatellitePlan.None(), null);
            Assert.Equal("No satellite is set up", s.MenuLine);
            Assert.Equal(IconLook.Grey, s.Look);
            Assert.True(s.RepairEnabled);
            Assert.False(s.CanStart);
            Assert.False(s.CanStop);
            Assert.False(s.AutostartEnabled);
            Assert.False(s.ShowCertificateEnabled);
            Assert.False(s.SatelliteItemsEnabled);
            Assert.False(s.GuideEnabled);
        }

        [Fact]
        public void An_unreadable_folder_gives_the_plans_reason()
        {
            TrayState s = Build(SatellitePlan.Failed("The folder Z:\\sat is not there (is the drive connected?)."), null);
            Assert.Equal("The satellite folder cannot be read: The folder Z:\\sat is not there (is the drive connected?).", s.MenuLine);
            Assert.Equal(IconLook.Grey, s.Look);
            Assert.True(s.RepairEnabled);
            Assert.False(s.SatelliteItemsEnabled);
            Assert.True(s.GuideEnabled);
        }

        [Fact]
        public void The_last_failed_commands_reason_is_on_the_first_line_too()
        {
            TrayState s = Build(Existing(), ContainerState.Stopped, true, "Start failed: port is already allocated");
            Assert.Equal("Stopped - Start failed: port is already allocated", s.MenuLine);
        }

        [Fact]
        public void A_very_long_reason_is_cut_and_flattened_on_the_menu_line()
        {
            TrayState s = Build(Existing(), ContainerState.Stopped, true, "line one\r\nline two " + new string('x', 400));
            Assert.True(s.MenuLine.Length <= TrayState.MenuLineLimit);
            Assert.DoesNotContain("\n", s.MenuLine);
            Assert.EndsWith("...", s.MenuLine);
        }

        [Fact]
        public void The_autostart_item_follows_the_plan()
        {
            Assert.True(Build(Existing("on"), ContainerState.Running).AutostartOn);
            Assert.False(Build(Existing("off"), ContainerState.Running).AutostartOn);
        }

        [Fact]
        public void The_certificate_item_needs_a_file_named_in_the_plan()
        {
            Assert.True(Build(Existing(), ContainerState.Running).ShowCertificateEnabled);
            SatellitePlan noCertificate = Existing();
            noCertificate.CertificateFile = "";
            Assert.False(Build(noCertificate, ContainerState.Running).ShowCertificateEnabled);
        }

        [Fact]
        public void The_state_before_the_first_answer_is_checking()
        {
            Assert.Equal(Situation.Checking, TrayState.Initial().Situation);
            Assert.Equal(IconLook.Grey, TrayState.Initial().Look);
        }

        [Theory]
        [InlineData("Running")]
        [InlineData("Stopped")]
        [InlineData("Starting")]
        [InlineData("DockerDown")]
        [InlineData("Missing")]
        public void The_tooltip_names_the_satellite_and_its_port_and_says_which_situation(string docker)
        {
            string tip = Build(Existing(), (ContainerState)Enum.Parse(typeof(ContainerState), docker)).Tooltip;
            Assert.Contains("7880", tip);
            // The long situation "Docker Desktop is not running" leaves no room for the name; the port stays.
            if (docker != "DockerDown") Assert.Contains("workstation", tip);
        }

        [Fact]
        public void The_tooltip_never_passes_windows_limit_of_63_characters_and_keeps_the_situation()
        {
            foreach (int nameLength in new[] { 0, 1, 5, 10, 20, 33, 40, 63, 64, 120, 500 })
            {
                foreach (ContainerState docker in (ContainerState[])Enum.GetValues(typeof(ContainerState)))
                {
                    TrayState s = Build(Existing("on", new string('n', nameLength), 65535), docker);
                    Assert.True(s.Tooltip.Length <= 63, "name length " + nameLength + " " + docker + ": " + s.Tooltip.Length + " " + s.Tooltip);
                    if (docker == ContainerState.DockerDown) Assert.EndsWith("Docker Desktop is not running", s.Tooltip);
                    if (docker == ContainerState.Running) Assert.EndsWith("running", s.Tooltip);
                }
            }
            foreach (TrayState s in new[]
            {
                TrayState.Initial(), Build(SatellitePlan.None(), null), Build(SatellitePlan.Failed(new string('e', 300)), null),
                Build(Existing(), ContainerState.Missing)
            })
                Assert.True(s.Tooltip.Length <= 63);
        }

        [Fact]
        public void A_long_name_is_shortened_not_the_situation()
        {
            string tip = Build(Existing("on", "a-really-quite-long-satellite-name-for-a-small-tooltip", 7880), ContainerState.Stopped).Tooltip;
            Assert.True(tip.Length <= 63);
            Assert.Contains("...", tip);
            Assert.EndsWith(", port 7880: stopped", tip);
        }

        [Fact]
        public void The_signature_changes_with_anything_the_window_shows()
        {
            string a = Build(Existing(), ContainerState.Running).Signature;
            Assert.Equal(a, Build(Existing(), ContainerState.Running).Signature);
            Assert.NotEqual(a, Build(Existing(), ContainerState.Stopped).Signature);
            Assert.NotEqual(a, Build(Existing("off"), ContainerState.Running).Signature);
            Assert.NotEqual(a, Build(Existing(), ContainerState.Running, true, "x").Signature);
        }
    }
}
