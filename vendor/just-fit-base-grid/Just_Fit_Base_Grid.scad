/* ================================================================
   GRIDFINITY CUSTOMISABLE SKELETON BASE PLATE
   ================================================================ */

/* [1. Unit System — Choose Sizing Mode First] */
// Pick your unit system, then scroll to the matching section:
//   Units → fill in section 2a
//   cm    → fill in section 2b
//   inch  → fill in section 2c
// All other size sections are ignored.
sizing_mode = "Units";  // [Units, cm, inch]


/* [2a. Size in Grid Units  (active when: sizing_mode = Units)] */
// 1 unit = 42 mm.  Whole numbers only.
// Tip: add margins in section 5 to fine-tune the fit.
// Width in grid units
size_x_u = 5.5;
// Depth in grid units
size_y_u = 4.5;

/* [2b. Size in Centimetres  (active when: sizing_mode = cm)] */
// The largest whole number of 42 mm cells that fits is used.
// Any remainder ≥ 21 mm can be filled with half-cells (see section 3).
// Width in centimetres
size_x_cm = 23.1;
// Depth in centimetres
size_y_cm = 16.8;

/* [2c. Size in Inches  (active when: sizing_mode = inch)] */
// The largest whole number of 42 mm cells that fits is used.
// Any remainder ≥ 21 mm can be filled with half-cells (see section 3).
// Width in inches
size_x_in = 9.0;
// Depth in inches
size_y_in = 7.0;


/* [3. Half-Cell Fill (21 mm edge strips)] */
// When enabled: if ≥ 21 mm remains at the RIGHT or BACK edge
// after fitting the 42 mm cells, that space receives rectangular
// half-cell pockets:
//
//   Right strip — pockets are 21 mm wide × 42 mm deep (1 per row)
//   Back  strip — pockets are 42 mm wide × 21 mm deep (1 per column)
//   Corner      — one 21 mm × 21 mm pocket where both strips meet
//
// ⚠ COMPATIBILITY: standard Gridfinity bins (42 mm) do NOT fit 21 mm
//   cells.  Only enable this if you also have mini Gridfinity bins.
enable_half_cells = true;


/* [4. Plate Height] */
// Total plate thickness in mm.
// Minimum is 5.10 mm (= 4.55 mm pocket depth + 0.55 mm solid floor).
// Values below this are raised automatically; a console warning is shown.
base_height = 6.0;


/* [5. Margins — Extra Border Around the Grid] */
// Solid blank material added outside the grid, in mm per side.
// Set all to 0 for a borderless grid-only plate.
// Note: any sub-21 mm remainder from the chosen size is
// distributed evenly into these margins automatically.
margin_left  = 2;
margin_right = 2;
margin_front = 2;
margin_back  = 2;


/* [6. Pocket Tolerance Adjustment] */
// Fine-tune the pocket opening size to match your printer's accuracy.
// Positive = slightly larger openings  (bins feel loose)
// Negative = slightly smaller openings (bins feel tight)
// Start at 0.0 mm and adjust in ±0.1 mm steps after a test print.
pocket_tolerance = 0.0;  // mm, typically -0.2 … +0.2


/* [7. Edge Step Relief — Ledge Notch for Drawer / Frame Fit] */
// Cuts a step notch into the bottom of selected edges so the plate
// can slide under a drawer lip or lock into a shelf rail.
// Height of the notch in mm — auto-clamped to the solid floor
// under the pockets so pocket geometry is never damaged.
step_height = 2.0;
// Width of the notch from the outer edge inward in mm.
// May safely extend past the margin and under the grid area.
step_width  = 3.0;
// Which edges receive the notch
step_left   = false;
step_right  = false;
step_front  = false;
step_back   = false;


/* [8. Corner Chamfer] */
// Bevel the four top outer corners of the plate
corner_chamfer = true;
// Chamfer size (mm)
chamfer_size   = 2.0;


/* [9. Print-Bed Tiling] */
// Splits plates too large for your bed into grid-seam-aligned tiles.
// All tiles are exported as separate shells in one STL — import into
// PrusaSlicer / OrcaSlicer / Bambu Studio and each shell becomes its
// own printable object automatically.
enable_tiling = false;
// Maximum printable width of your bed (mm)
bed_x = 235;
// Maximum printable depth of your bed (mm)
bed_y = 235;
// Layout   — tiles spread apart with gap; use when exporting for print.
// Assembled— tiles at exact joined positions; use to verify the split.
tile_display = "Layout";  // [Layout, Assembled]
// Gap between tiles in Layout view (mm)
tile_gap = 10;


// ═══════════════════════════════════════════════════════════════
// DERIVED CONSTANTS  (hidden from customiser)
// ═══════════════════════════════════════════════════════════════
/* [Hidden] */
$fn = 64;

// ── Gridfinity pocket geometry (defined by the standard) ─────
_foot_vertical = 2.15;
_foot_taper    = 2.40;
_pocket_depth  = _foot_vertical + _foot_taper;   // 4.55 mm

// ── Base height enforcement ───────────────────────────────────
_min_bh = _pocket_depth + 0.55;                  // 5.10 mm
_bh     = max(base_height, _min_bh);
_warn_h = (_bh > base_height)
    ? echo(str("⚠  base_height ", base_height, " mm is below the minimum ",
               _min_bh, " mm — clamped to ", _bh, " mm"))
    : 0;

// ── Convert chosen input to mm ────────────────────────────────
_input_mm_x = (sizing_mode == "cm")   ? size_x_cm * 10
            : (sizing_mode == "inch")  ? size_x_in * 25.4
            :                            size_x_u  * 42;
_input_mm_y = (sizing_mode == "cm")   ? size_y_cm * 10
            : (sizing_mode == "inch")  ? size_y_in * 25.4
            :                            size_y_u  * 42;

// ── Whole 42 mm cells ─────────────────────────────────────────
_cols42 = floor(_input_mm_x / 42);
_rows42 = floor(_input_mm_y / 42);

// ── Remainder after 42 mm cells (mm) ─────────────────────────
_rem_x  = _input_mm_x - _cols42 * 42;
_rem_y  = _input_mm_y - _rows42 * 42;

// ── Half-cell edge strip flags ────────────────────────────────
_hx = (enable_half_cells && _rem_x >= 21) ? 1 : 0;  // right strip present
_hy = (enable_half_cells && _rem_y >= 21) ? 1 : 0;  // back  strip present

// ── Grid area in mm (all pocket cells, no margins) ───────────
_grid_w = _cols42 * 42 + _hx * 21;
_grid_d = _rows42 * 42 + _hy * 21;

// ── Distribute sub-21 mm remainder into auto-margins ─────────
_auto_rem_x = _input_mm_x - _grid_w;
_auto_rem_y = _input_mm_y - _grid_d;
_auto_ml    = floor(_auto_rem_x / 2);
_auto_mr    = ceil (_auto_rem_x / 2);
_auto_mf    = floor(_auto_rem_y / 2);
_auto_mb    = ceil (_auto_rem_y / 2);

// ── Final margins (user + auto-distributed remainder) ─────────
_ml = margin_left  + _auto_ml;
_mr = margin_right + _auto_mr;
_mf = margin_front + _auto_mf;
_mb = margin_back  + _auto_mb;

// ── Overall plate footprint ───────────────────────────────────
_total_w = _grid_w + _ml + _mr;
_total_d = _grid_d + _mf + _mb;

// ── Console summary ───────────────────────────────────────────
_echo = echo(str(
    "42 mm grid: ", _cols42, "×", _rows42,
    _hx ? str("  + right strip (21×42 mm, ", _rows42, " pockets)") : "",
    _hy ? str("  + back strip (42×21 mm, ",  _cols42, " pockets)") : "",
    (_hx && _hy) ? "  + 1 corner pocket (21×21 mm)" : "",
    "  |  Plate: ", _total_w, "×", _total_d, " mm",
    pocket_tolerance != 0
        ? str("  |  pocket tolerance: ", pocket_tolerance, " mm") : ""
));

// ── Grid-aligned tile geometry ────────────────────────────────
// Tile cuts fall only on 42 mm seams — no pocket is ever bisected.
// Half-cell strips always land in the last tile (right/back edge).
_cpx     = max(1, floor((bed_x - _ml) / 42));
_cpy     = max(1, floor((bed_y - _mf) / 42));
_tiles_x = enable_tiling ? ceil(_cols42 / _cpx) : 1;
_tiles_y = enable_tiling ? ceil(_rows42 / _cpy) : 1;

function _tx0(tx) = (tx == 0)          ? 0        : _ml + tx * _cpx * 42;
function _tx1(tx) = (tx < _tiles_x-1)  ? _ml + (tx+1) * _cpx * 42 : _total_w;
function _ty0(ty) = (ty == 0)          ? 0        : _mf + ty * _cpy * 42;
function _ty1(ty) = (ty < _tiles_y-1)  ? _mf + (ty+1) * _cpy * 42 : _total_d;
function _tw(tx)  = _tx1(tx) - _tx0(tx);
function _td(ty)  = _ty1(ty) - _ty0(ty);
function _lx(tx)  = (tx == 0) ? 0 : _lx(tx-1) + _tw(tx-1) + tile_gap;
function _ly(ty)  = (ty == 0) ? 0 : _ly(ty-1) + _td(ty-1) + tile_gap;


// ═══════════════════════════════════════════════════════════════
// GEOMETRY MODULES
// ═══════════════════════════════════════════════════════════════

module _sq(w, d, r) {
    if (r <= 0) square([w, d], center = true);
    else        offset(r = r) square([w - 2*r, d - 2*r], center = true);
}

// ── Rectangular pocket — pw × pd footprint ───────────────────
//
// pw / pd = pocket width / depth in mm (may differ for half-cells).
// pocket_tolerance expands every opening uniformly for fit tuning.
//
// Taper geometry uses the smaller of pw/pd to stay within bounds.
// The shaft and flare profiles are rectangular, matching pw × pd.
//
module _socket_cutout(pw, pd) {
    _t       = pocket_tolerance;
    _r_top   = (min(pw, pd) >= 42) ? 4.0 : 2.0;
    _r_mid   = max(0.1, _r_top - _foot_taper);
    _mid_w   = pw - _foot_taper * 2;
    _mid_d   = pd - _foot_taper * 2;

    // Straight shaft
    hull() {
        linear_extrude(0.001)
            _sq(_mid_w + _t, _mid_d + _t, _r_mid);
        translate([0, 0, _foot_vertical])
            linear_extrude(0.001)
                _sq(_mid_w + _t, _mid_d + _t, _r_mid);
    }
    // Tapered flare
    hull() {
        translate([0, 0, _foot_vertical])
            linear_extrude(0.001)
                _sq(_mid_w + _t, _mid_d + _t, _r_mid);
        translate([0, 0, _foot_vertical + _foot_taper])
            linear_extrude(0.001)
                _sq(pw + _t, pd + _t, _r_top);
    }
    // Open column above pocket
    translate([0, 0, _foot_vertical + _foot_taper])
        linear_extrude(_bh)
            _sq(pw + _t, pd + _t, _r_top);
}

module _skeleton_cutout(pw, pd) {
    _t     = pocket_tolerance;
    _r_top = (min(pw, pd) >= 42) ? 4.0 : 2.0;
    _r_mid = max(0.1, _r_top - _foot_taper);
    _mid_w = pw - _foot_taper * 2;
    _mid_d = pd - _foot_taper * 2;

    translate([0, 0, -_bh * 2])
        linear_extrude(_bh * 4)
            _sq(_mid_w + _t, _mid_d + _t, _r_mid);
}

module _pocket(pw, pd) {
    _socket_cutout(pw, pd);
    _skeleton_cutout(pw, pd);
}

module _step_relief_cut() {
    _floor_h = _bh - _pocket_depth;
    _safe_h  = min(step_height, _floor_h);

    if (_safe_h > 0 && step_width > 0) {
        if (step_left)
            translate([-1, -1, -0.1])
                cube([step_width + 1, _total_d + 2, _safe_h + 0.1]);
        if (step_right)
            translate([_total_w - step_width, -1, -0.1])
                cube([step_width + 1, _total_d + 2, _safe_h + 0.1]);
        if (step_front)
            translate([-1, -1, -0.1])
                cube([_total_w + 2, step_width + 1, _safe_h + 0.1]);
        if (step_back)
            translate([-1, _total_d - step_width, -0.1])
                cube([_total_w + 2, step_width + 1, _safe_h + 0.1]);
    }
}

module _corner_chamfer_cut() {
    difference() {
        translate([-10, -10, -0.1])
            cube([_total_w + 20, _total_d + 20, chamfer_size + 0.1]);
        hull() {
            translate([chamfer_size, chamfer_size, -0.2])
                cube([_total_w - 2*chamfer_size, _total_d - 2*chamfer_size, 0.1]);
            translate([0, 0, chamfer_size])
                cube([_total_w, _total_d, 0.1]);
        }
    }
}

module full_baseplate() {
    difference() {
        cube([_total_w, _total_d, _bh]);

        translate([_ml, _mf, _bh - _pocket_depth]) {

            // ── Main 42 × 42 mm grid ──────────────────────────
            for (x = [0 : _cols42 - 1], y = [0 : _rows42 - 1])
                translate([x*42 + 21, y*42 + 21, 0])
                    _pocket(42, 42);

            // ── Right strip: 21 mm wide × 42 mm deep pockets ──
            // One pocket per full row — half the width, full depth.
            if (_hx)
                for (y = [0 : _rows42 - 1])
                    translate([_cols42*42 + 10.5, y*42 + 21, 0])
                        _pocket(21, 42);

            // ── Back strip: 42 mm wide × 21 mm deep pockets ───
            // One pocket per full column — full width, half the depth.
            if (_hy)
                for (x = [0 : _cols42 - 1])
                    translate([x*42 + 21, _rows42*42 + 10.5, 0])
                        _pocket(42, 21);

            // ── Corner pocket: 21 × 21 mm ─────────────────────
            // Only present when both strips exist.
            if (_hx && _hy)
                translate([_cols42*42 + 10.5, _rows42*42 + 10.5, 0])
                    _pocket(21, 21);
        }

        _step_relief_cut();
        if (corner_chamfer) _corner_chamfer_cut();
    }
}

module _tiled_output() {
    for (tx = [0 : _tiles_x - 1], ty = [0 : _tiles_y - 1]) {
        dx = (tile_display == "Layout") ? _lx(tx) - _tx0(tx) : 0;
        dy = (tile_display == "Layout") ? _ly(ty) - _ty0(ty) : 0;

        translate([dx, dy, 0])
        intersection() {
            translate([_tx0(tx), _ty0(ty), -0.1])
                cube([_tw(tx), _td(ty), _bh + 0.2]);
            full_baseplate();
        }
    }
}


// ═══════════════════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════
if (enable_tiling)  _tiled_output();
else                full_baseplate();