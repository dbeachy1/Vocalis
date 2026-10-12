// Shared [Code] of vocalis.iss and vocalis-satellite.iss (each has `#include "wizard-header-picture.iss"` inside its
// [Code] section, before InitializeWizard, and calls PlaceHeaderPicture first thing in InitializeWizard). One copy, so the
// two setup programs cannot drift apart. Keep this file pure ASCII.
//
// October 11, 2026. Doug, looking at the real satellite setup program: the Vocalis V in the corner of every inner page
// "needs a little bit more space between the icon edge and the edge of the frame on the top and the right ... It should
// match the gap on the top and the left for the left side of the text." What the page title has is a gap of its own
// Top from the top of the header and its own Left from the left edge of the window. Inno Setup 6.7.3's modern wizard puts
// the small picture in the top right corner of the header, filling the header's whole height (header 596x58 and picture
// 58x58 at left 538, top 0, title label left 24 and top 8 at 100%, measured October 11, 2026).
//
// make_icon.py draws each small picture file with its dark square a transparent margin away from every edge of the picture
// (the margin is the title label's Top at that display scaling), so the square sits that far from the top and the bottom of
// the header. This procedure does the horizontal half and makes the vertical half exact: it moves the picture left until
// the square's right edge is the title label's Left away from the right edge of the header, and narrows the title and the
// description by the distance moved so neither runs under the picture. The picture keeps its own size: the file Setup
// picked is exactly the size of the picture area, so it is drawn at its own pixel size, not stretched.
//
// The margin is worked out from the numbers Inno gives the controls, not hard-coded: the square is the header's height
// minus twice the title's Top (what make_icon.py draws), so the margin is half of what is left of the picture's width.
// The picture keeps its place when the window is resized: its anchors (top and right) hold the gap from the new position,
// and the two labels keep their new distance from the right edge. Checked October 11, 2026 by making the wizard window
// 160 pixels wider on the licence page: the page re-flowed and the square stayed 24 pixels from the right edge.
procedure PlaceHeaderPicture;
var
  Picture: TBitmapImage;
  HeaderWidth, HeaderHeight, TitleLeft, TitleTop, Margin, NewLeft, NewTop, Shift: Integer;
begin
  Picture := WizardForm.WizardSmallBitmapImage;
  HeaderWidth := WizardForm.MainPanel.ClientWidth;
  HeaderHeight := WizardForm.MainPanel.ClientHeight;
  TitleLeft := WizardForm.PageNameLabel.Left;
  TitleTop := WizardForm.PageNameLabel.Top;
  Margin := (Picture.Width - (HeaderHeight - 2 * TitleTop)) div 2;
  NewTop := (HeaderHeight - Picture.Height) div 2;
  NewLeft := HeaderWidth - TitleLeft - (Picture.Width - Margin);
  Shift := Picture.Left - NewLeft;
  Log('Header picture: header ' + IntToStr(HeaderWidth) + 'x' + IntToStr(HeaderHeight) + ', title label left ' + IntToStr(TitleLeft) +
    ' top ' + IntToStr(TitleTop) + ', picture ' + IntToStr(Picture.Width) + 'x' + IntToStr(Picture.Height) + ' at left ' +
    IntToStr(Picture.Left) + ' top ' + IntToStr(Picture.Top) + ', picture file ' + IntToStr(Picture.Bitmap.Width) + 'x' +
    IntToStr(Picture.Bitmap.Height) + ', margin ' + IntToStr(Margin) + ', new left ' + IntToStr(NewLeft) + ' top ' + IntToStr(NewTop) +
    ', moved left by ' + IntToStr(Shift));
  if (Margin < 0) or (Shift <= 0) then
  begin
    Log('Header picture: left where Setup put it (the numbers do not describe a header this procedure knows).');
    Exit;
  end;
  Picture.SetBounds(NewLeft, NewTop, Picture.Width, Picture.Height);
  WizardForm.PageNameLabel.Width := WizardForm.PageNameLabel.Width - Shift;
  WizardForm.PageDescriptionLabel.Width := WizardForm.PageDescriptionLabel.Width - Shift;
  Log('Header picture: placed; title label width ' + IntToStr(WizardForm.PageNameLabel.Width) + ', description label width ' +
    IntToStr(WizardForm.PageDescriptionLabel.Width));
end;
