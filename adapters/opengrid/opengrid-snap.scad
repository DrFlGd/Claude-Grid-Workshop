// SCAD Workshop adapter for the openGrid Snap.
//
// The upstream file (vendor/quackworks/openGrid/opengrid-snap.scad) defines the
// openGridSnap() module and ends with a hard-coded call. `use` imports the
// module without running that call, so the options below can drive it.
// Upstream code and the snap design keep their own licenses and credits:
// openGrid by David D, OpenSCAD by metasyntactic / QuackWorks.

include <BOSL2/std.scad>
use <../../vendor/quackworks/openGrid/opengrid-snap.scad>

/* [Snap] */
// Lite snaps are thinner, for openGrid Lite tiles.
Snap_Type = "Full"; // [Full, Lite]
// Directional snaps lock on two sides only and show an arrow.
Directional = false;
// Number of snaps to lay out on the bed.
Count = 1; // [1:1:16]
// Gap between snaps in mm.
Spacing = 4; // [1:1:20]

/* [Hidden] */
$fn = 64;
snap_w = 24.8;
cols = ceil(sqrt(Count));

for (i = [0 : Count - 1])
    translate([(i % cols) * (snap_w + Spacing), floor(i / cols) * (snap_w + Spacing), 0])
        openGridSnap(lite = Snap_Type == "Lite", directional = Directional, anchor = BOT);
