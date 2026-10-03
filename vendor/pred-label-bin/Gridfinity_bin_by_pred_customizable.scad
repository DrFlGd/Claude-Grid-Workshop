// ===== Gridfinity Bin with Pred-Style Snap-In Label Holder ===== //
// Customizable model by 3DLG
// Matching snap-in labels by 3DLG:
// https://makerworld.com/en/models/769441-label-generator-gridfinity-bin#profileId-705079
//
// Credits:
// - Original parametric Gridfinity bin base by ABDELat:
//   https://makerworld.com/models/4759
// - Based on gridfinity-rebuilt-openscad:
//   https://github.com/kennetek/gridfinity-rebuilt-openscad
//
// Original base license: CC-Attribution-Noncommercial-Share Alike

// preview[view:south west, tilt:side]

// ===== CUSTOMIZER SETTINGS ===== //

/* [📐 Bin Dimensions] */
// Width of the bin in Gridfinity units. 1 unit = 42 mm.
Bin_Width = 1;  
// Depth of the bin in Gridfinity units. 1 unit = 42 mm.
Bin_Depth = 1;  
// Height of the bin in Gridfinity height units.
Bin_Height = 6;

/* [🧩 Compartments] */
// Number of compartments from left to right. Set to 0 for a solid bin.
Compartments_Left_To_Right = 1;
// Number of compartments from front to back. Set to 0 for a solid bin.
Compartments_Front_To_Back = 1;

/* [📏 Advanced Height] */
// Choose how the height value is interpreted.
Height_Mode = 0; // [0:Gridfinity units, 1:Internal height in mm, 2:Overall height in mm]
// Override internal height in mm. Leave 0 for automatic.
Internal_Height_mm = 0; 
// Snap height to the nearest 7 mm Gridfinity increment.
Snap_Height_To_Grid = false;

/* [⚙️ Bin Options] */
// Choose the top lip style.
Top_Lip_Style = 0; //[0:Regular stacking lip, 1:Remove lip subtractively, 2:Remove lip and keep height]
// Scoop size for easier part removal. 0 disables scoop, 1 is normal.
Scoop_Size = 1; //[0:0.1:1]
// Only cut magnet/screw holes at the outside corners.
Corner_Holes_Only = false;
// Add the Pred-style snap-in label holder for the matching labels.
Label_Holder = true;
// Bottom hole style for magnets and/or screws.
Base_Hole_Style = 0; // [0:No holes, 1:Magnet holes only, 2:Magnet and screw holes, 3:Magnet and screw holes with printable slit]

/* [🎨 Colors] */
// Main bin color, including walls and bottom base.
Bin_Color = "#FF5A1F"; // color
// Separate color for the top edge / stacking lip.
Top_Edge_Color = "#FF5A1F"; // color
// Height of the colored top edge in mm.
Top_Edge_Color_Height = 1.0; // [0.5:0.05:8]



/* [Hidden] */
div_base_x = 0;
div_base_y = 0;
label_cut_depth = 1.0;
label_position_x = 0;
label_position_y = 1.0;
style_tab = Label_Holder ? 0 : 5;
pred_label_clearance = 0.35;
pred_label_back_offset = 3.4;
pred_label_holder_margin = 3.0;

/* Setup Parameters */
$fa = 8;
$fs = 0.35;

// height of the base
$h_base = 5;     
// outside rounded radius of bin
$r_base = 4;     
// lower base chamfer "radius"
$r_c1 = 0.8;     
// upper base chamfer "radius"
$r_c2 = 2.4;     
// bottom wall thickness of bin
$h_bot = 2.2;    
// outside radii 1
$r_fo1 = 8.5;    
// outside radii 2
$r_fo2 = 3.2;
// outside radii 3
$r_fo3 = 1.6; 
// length of a grid unit (classic gridfinity = 42mm)
l_grid = 42;

// screw hole radius
$r_hole1 = 1.5;  
// magnet hole radius
$r_hole2 = 3.25; 
// center-to-center distance between holes
$d_hole = 26;  
// distance of hole from side of bin
$d_hole_from_side=8;
// magnet hole depth
$h_hole = 2.4;   
// slit depth (printer layer height)
$h_slit = 0.2; 

// top edge fillet radius
$r_f1 = 0.6;     
// internal fillet radius
$r_f2 = 2.8;     

// width of divider between compartments
$d_div = 1.2;    
// minimum wall thickness
d_wall = 0.95;  
// tolerance fit factor 
d_clear = 0.25; 

// height of tab (yaxis, measured from inner wall)
d_tabh = max(15.85, 11.5 + 2 * pred_label_clearance + pred_label_holder_margin);
// maximum width of tab 
d_tabw = 42; 
// angle of tab   
$a_tab = 36; 
// lip height
$h_lip = 3.548;

d_wall2 = $r_base-$r_c1-d_clear*sqrt(2);
d_magic = -2*d_clear-2*d_wall+$d_div; 

// ===== Internal Geometry Modules ===== //

// functions to convert gridz values to mm values
function hf (z, d, l) = ((d==0)?z*7:(d==1)?$h_bot+z+$h_base:z-((l==1)?$h_lip:0))+(l==2?$h_lip:0);
function height (z,d=0,l=0,s=true) = (s?((abs(hf(z,d,l))%7==0)?hf(z,d,l):hf(z,d,l)+7-abs(hf(z,d,l))%7):hf(z,d,l))-$h_base;

// Creates equally divided cutters for the bin
//
// n_divx:  number of x compartments (ideally, coprime w/ gridx)    
// n_divy:  number of y compartments (ideally, coprime w/ gridy) 
//          set n_div values to 0 for a solid bin 
// style_tab:   tab style for all compartments. see cut()
// scoop_weight:    scoop toggle for all compartments. see cut()
module cutEqual(n_divx=1, n_divy=1, style_tab=1, scoop_weight=1) {
    for (i = [1:n_divx]) 
    for (j = [1:n_divy])
    cut((i-1)*$gxx/n_divx,(j-1)*$gyy/n_divy, $gxx/n_divx, $gyy/n_divy, style_tab, scoop_weight);
}

module gridfinity_bottom_with_cuts(gx, gy, h, h0 = 0, l = l_grid) {
    $gxx = gx;
    $gyy = gy;
    $dh = h;
    $dh0 = h0;

    difference() {
        block_bottom(h0==0?$dh-0.1:h0, gx, gy, l);
        children();
    }
}

module gridfinity_top_edge(gx, gy, h, l = l_grid) {
    $gxx = gx;
    $gyy = gy;
    $dh = h;

    block_wall(gx, gy, l) {
        if (Top_Lip_Style == 0) profile_wall();
        else profile_wall2();
    }
}

module gridfinity_top_edge_color_band(gx, gy, h, l = l_grid) {
    top_z = h + 2 * $h_base;
    band_height = Top_Edge_Color_Height + $h_base;

    intersection() {
        gridfinity_top_edge(gx, gy, h, l);
        translate([-gx * l, -gy * l, top_z - band_height])
            cube([2 * gx * l, 2 * gy * l, band_height + 0.2]);
    }
}
// Function to include in the custom() module to individually slice bins
// Will try to clamp values to fit inside the provided base size
//
// x:   start coord. x=1 is the left side of the bin.
// y:   start coord. y=1 is the bottom side of the bin. 
// w:   width of compartment, in # of bases covered
// h:   height of compartment, in # of bases covered
// t:   tab style of this specific compartment.
//      alignment only matters if the compartment size is larger than d_tabw
//      0:full, 1:auto, 2:left, 3:center, 4:right, 5:none
//      Automatic alignment will use left tabs for bins on the left edge, right tabs for bins on the right edge, and center tabs everywhere else. 
// s:   toggle the rounded back corner that allows for easy removal
module cut(x=0, y=0, w=1, h=1, t=1, s=1) {
    translate([0,0,-$dh-$h_base])
    cut_move(x,y,w,h)
    block_cutter(clp(x,0,$gxx), clp(y,0,$gyy), clp(w,0,$gxx-x), clp(h,0,$gyy-y), t, s);
}

// Translates an object from the origin point to the center of the requested compartment block, can be used to add custom cuts in the bin
// See cut() module for parameter descriptions
module cut_move(x, y, w, h) {
    translate([0,0,$dh0==0?$dh+$h_base:$dh0+$h_base])
    cut_move_unsafe(clp(x,0,$gxx), clp(y,0,$gyy), clp(w,0,$gxx-x), clp(h,0,$gyy-y))
    children();
} 

// ===== Modules ===== //

module profile_base() {
    polygon([
        [0,0],
        [0,$h_base],
        [$r_base,$h_base],
        [$r_base-$r_c2,$h_base-$r_c2],
        [$r_base-$r_c2,$r_c1],
        [$r_base-$r_c2-$r_c1,0]
    ]);
}

module gridfinityBase(gx, gy, l, dx, dy, style_hole, off=0, final_cut=true, only_corners=false) {
    dbnxt = [for (i=[1:5]) if (abs(gx*i)%1 < 0.001 || abs(gx*i)%1 > 0.999) i];
    dbnyt = [for (i=[1:5]) if (abs(gy*i)%1 < 0.001 || abs(gy*i)%1 > 0.999) i];
    dbnx = 1/(dx==0 ? len(dbnxt) > 0 ? dbnxt[0] : 1 : round(dx));
    dbny = 1/(dy==0 ? len(dbnyt) > 0 ? dbnyt[0] : 1 : round(dy));
    xx = gx*l-0.5;
    yy = gy*l-0.5;
    
    if (final_cut)
    translate([0,0,$h_base])
    rounded_rectangle(xx+0.002, yy+0.002, $h_bot/1.5, $r_fo1/2+0.001);

    intersection(){
        if (final_cut) 
        translate([0,0,-1])
        rounded_rectangle(xx+0.005, yy+0.005, $h_base+$h_bot/2*10, $r_fo1/2+0.001);
        
        if(only_corners) {
                difference(){
                pattern_linear(gx/dbnx, gy/dbny, dbnx*l, dbny*l) 
                block_base(gx, gy, l, dbnx, dbny, 0, off);
                pattern_linear(2, 2, (gx-1)*l_grid+$d_hole, (gy-1)*l_grid+$d_hole)
                block_base_hole(style_hole, off);
            }
        }
        else {
            pattern_linear(gx/dbnx, gy/dbny, dbnx*l, dbny*l) 
            block_base(gx, gy, l, dbnx, dbny, style_hole, off);
        }
    }
}

module block_base(gx, gy, l, dbnx, dbny, style_hole, off) {
    render(convexity = 2)
    difference() {
        block_base_solid(dbnx, dbny, l, off);
        
        if (style_hole > 0)
            pattern_circular(abs(l-$d_hole_from_side/2)<0.001?1:4) 
            translate([l/2-$d_hole_from_side, l/2-$d_hole_from_side, 0])
            block_base_hole(style_hole, off);
        }
}

module block_base_solid(dbnx, dbny, l, o) { 
    xx = dbnx*l-0.05; 
    yy = dbny*l-0.05; 
    oo = (o/2)*(sqrt(2)-1);
    translate([0,0,$h_base])
    mirror([0,0,1])
    union() {
        hull() {
            rounded_rectangle(xx-2*$r_c2-2*$r_c1+o, yy-2*$r_c2-2*$r_c1+o, $h_base+oo, $r_fo3/2);
            rounded_rectangle(xx-2*$r_c2+o, yy-2*$r_c2+o, $h_base-$r_c1+oo, $r_fo2/2);
        }
        translate([0,0,oo])
        hull() {
            rounded_rectangle(xx-2*$r_c2+o, yy-2*$r_c2+o, $r_c2, $r_fo2/2);
            mirror([0,0,1])
            rounded_rectangle(xx+o, yy+o, $h_bot/2+abs(10*o), $r_fo1/2);
        }
    }
}

module block_base_hole(style_hole, o=0) {
    r1 = $r_hole1-o/2;
    r2 = $r_hole2-o/2;
    union() {
        difference() {
            cylinder(h = 2*($h_hole-o+(style_hole==3?$h_slit:0)), r=r2, center=true);

            if (style_hole==3)
            copy_mirror([0,1,0])
            translate([-1.5*r2,r1+0.1,$h_hole-o]) 
            cube([r2*3,r2*3, 10]);
        }
        if (style_hole > 1)
        cylinder(h = 2*$h_base-o, r = r1, center=true);
    }
}

module profile_wall_sub_sub() {
    polygon([
        [0,0],
        [d_wall/2,0],
        [d_wall/2,$dh-1.2-d_wall2+d_wall/2],
        [d_wall2-d_clear,$dh-1.2],
        [d_wall2-d_clear,$dh+$h_base],
        [0,$dh+$h_base]
    ]);
}

module profile_wall_sub() {
    difference() {
        profile_wall_sub_sub();
        offset(delta = d_clear) 
        translate([$r_base-d_clear,$dh,0])
        mirror([1,0,0]) 
        profile_base();
    }
}

module profile_wall() {
    translate([$r_base,0,0])
    mirror([1,0,0])
    difference() {
        profile_wall_sub();
        difference() {
            translate([0, $dh+$h_base-d_clear*sqrt(2), 0]) 
            circle($r_base/2);
            offset(r = $r_f1) 
            offset(delta = -$r_f1)
            profile_wall_sub();
        }
        // remove any negative geometry in edge cases
        mirror([0,1,0])
        square(100*l_grid);
    }
}

// lipless profile
module profile_wall2() {
    translate([$r_base,0,0]) 
    mirror([1,0,0]) 
    square([d_wall,$dh]);
}

module block_wall(gx, gy, l) {
    translate([0,0,$h_base]) 
    sweep_rounded(gx*l-2*$r_base-0.5-0.001, gy*l-2*$r_base-0.5-0.001)
    children();
}

module block_bottom( h = 2.2, gx, gy, l ) {
    translate([0,0,$h_base+0.1])
    rounded_rectangle(gx*l-0.5-d_wall/4, gy*l-0.5-d_wall/4, h, $r_base+0.01);
}

module cut_move_unsafe(x, y, w, h) {
    xx = ($gxx*l_grid+d_magic);
    yy = ($gyy*l_grid+d_magic); 
    translate([(x)*xx/$gxx,(y)*yy/$gyy,0])
    translate([(-xx+$d_div)/2,(-yy+$d_div)/2,0])
    translate([(w*xx/$gxx-$d_div)/2,(h*yy/$gyy-$d_div)/2,0])
    children();
}

module block_cutter(x,y,w,h,t,s) {
    
    v_len_tab = d_tabh;
    v_len_lip = d_wall2-d_wall+1.2;
    v_cut_tab = d_tabh - (2*$r_f1)/tan($a_tab); 
    v_cut_lip = d_wall2-d_wall-d_clear;
    v_ang_tab = $a_tab;
    v_ang_lip = 45;
    
    ycutfirst = y == 0 && Top_Lip_Style == 0;
    ycutlast = abs(y+h-$gyy)<0.001 && Top_Lip_Style == 0; 
    xcutfirst = x == 0 && Top_Lip_Style == 0;
    xcutlast = abs(x+w-$gxx)<0.001 && Top_Lip_Style == 0;
    zsmall = ($dh+$h_base)/7 < 3;
    
    ylen = h*($gyy*l_grid+d_magic)/$gyy-$d_div; 
    xlen = w*($gxx*l_grid+d_magic)/$gxx-$d_div; 
    
    height = $dh;
    extent = (abs(s) > 0 && ycutfirst ? d_wall2-d_wall-d_clear : 0); 
    tab = (zsmall || t == 5) ? (ycutlast?v_len_lip:0) : v_len_tab; 
    ang = (zsmall || t == 5) ? (ycutlast?v_ang_lip:0) : v_ang_tab;
    cut = (zsmall || t == 5) ? (ycutlast?v_cut_lip:0) : v_cut_tab;
    style = (t > 1 && t < 5) ? t-3 : (x == 0 ? -1 : xcutlast ? 1 : 0);
    
    translate([0,ylen/2,$h_base+$h_bot])
    rotate([90,0,-90]) {
    
    if (!zsmall && xlen - d_tabw > 4*$r_f2 && t != 0) {
        fillet_cutter(3,"bisque")
        difference() {
            transform_tab(style, xlen, ((xcutfirst&&style==-1)||(xcutlast&&style==1))?v_cut_lip:0)
            translate([ycutlast?v_cut_lip:0,0]) 
            profile_cutter(height-$h_bot, ylen/2, s);

            if (xcutfirst)
            translate([0,0,(xlen/2-$r_f2)-v_cut_lip]) 
            cube([ylen,height,v_cut_lip*2]);
            
            if (xcutlast)
            translate([0,0,-(xlen/2-$r_f2)-v_cut_lip])
            cube([ylen,height,v_cut_lip*2]);
        }
        if (t != 0 && t != 5)
        fillet_cutter(2,"indigo")
        difference() {
            transform_tab(style, xlen, ((xcutfirst&&style==-1)||(xcutlast&&style==1))?v_cut_lip:0)
            difference() {
                intersection() {
                    profile_cutter(height-$h_bot, ylen-extent, s);
                    profile_cutter_tab(height-$h_bot, v_len_tab, v_ang_tab);
                }
                if (ycutlast) profile_cutter_tab(height-$h_bot, v_len_lip, 45);
            } 
            
            if (xcutfirst)
            translate([ylen/2,0,xlen/2])
            rotate([0,90,0])
            transform_main(2*ylen)
            profile_cutter_tab(height-$h_bot, v_len_lip, v_ang_lip);
            
            if (xcutlast)
            translate([ylen/2,0,-xlen/2])
            rotate([0,-90,0])
            transform_main(2*ylen)
            profile_cutter_tab(height-$h_bot, v_len_lip, v_ang_lip);
        }
    }
    
    fillet_cutter(1,"seagreen")
    translate([0,0,xcutlast?v_cut_lip/2:0])
    translate([0,0,xcutfirst?-v_cut_lip/2:0])
    transform_main(xlen-(xcutfirst?v_cut_lip:0)-(xcutlast?v_cut_lip:0))
    translate([cut,0]) 
    profile_cutter(height-$h_bot, ylen-extent-cut-(!s&&ycutfirst?v_cut_lip:0), s);
    
    fillet_cutter(0,"hotpink")
    difference() {
        transform_main(xlen)
        difference() {
            profile_cutter(height-$h_bot, ylen-extent, s);
            
            if (!((zsmall || t == 5) && !ycutlast))
            profile_cutter_tab(height-$h_bot, tab, ang);
            
            if (!(abs(s) > 0)&& y == 0)
            translate([ylen-extent,0,0])
            mirror([1,0,0])
            profile_cutter_tab(height-$h_bot, v_len_lip, v_ang_lip);
        }
        
        if (xcutfirst)
        translate([ylen/2+0.001,0,xlen/2+0.001])
        rotate([0,90,0])
        transform_main(2*ylen)
        profile_cutter_tab(height-$h_bot, v_len_lip, v_ang_lip);
        
        if (xcutlast)
        translate([ylen/2+0.001,0,-xlen/2+0.001])
        rotate([0,-90,0])
        transform_main(2*ylen)
        profile_cutter_tab(height-$h_bot, v_len_lip, v_ang_lip);
    }

    }
}

module transform_main(xlen) {
    translate([0,0,-(xlen-2*$r_f2)/2])
    linear_extrude(xlen-2*$r_f2)
    children();
}

module transform_tab(type, xlen, cut) {
    mirror([0,0,type==1?1:0])
    copy_mirror([0,0,-(abs(type)-1)])
    translate([0,0,-(xlen)/2])
    translate([0,0,$r_f2])
    linear_extrude((xlen-d_tabw-abs(cut))/(1-(abs(type)-1))-2*$r_f2)
    children();
}

module fillet_cutter(t = 0, c = "goldenrod") {
    minkowski() {
        children();
        sphere(r = $r_f2-t/1000);
    }
}

module profile_cutter(h, l, s) {
    scoop = max(s*$dh/2-$r_f2,0); 
    translate([$r_f2,$r_f2])
    hull() {
        if (l-scoop-2*$r_f2 > 0)
            square(0.1);
        if (scoop < h) {
            translate([l-2*$r_f2,h-$r_f2/2]) 
            mirror([1,1]) 
            square(0.1);
            
            translate([0,h-$r_f2/2]) 
            mirror([0,1]) 
            square(0.1);
        }
        difference() {
            translate([l-scoop-2*$r_f2, scoop]) 
            if (scoop != 0) {
                intersection() {
                    circle(scoop);
                    mirror([0,1]) square(2*scoop);
                }
            } else mirror([1,0]) square(0.1);
            translate([l-scoop-2*$r_f2,-1]) 
            square([-(l-scoop-2*$r_f2),2*h]);
            
            translate([0,h]) 
            square([2*l,scoop]);
        }
    }
}

module profile_cutter_tab(h, tab, ang) {
    if (tab > 0)
        offset(delta = $r_f2)
        polygon([[0,h],[tab,h],[0,h-tab*tan(ang)]]);
    
}

// ==== Utilities =====

function clp(x,a,b) = min(max(x,a),b);

module rounded_rectangle(length, width, height, rad) {
    linear_extrude(height)
    offset(rad) 
    offset(-rad) 
    square([length,width], center = true);
}

module copy_mirror(vec=[0,1,0]) {
    children();
    if (vec != [0,0,0]) 
    mirror(vec) 
    children();
} 

module pattern_linear(x = 1, y = 1, sx = 0, sy = 0) {
    yy = sy <= 0 ? sx : sy; 
    translate([-(x-1)*sx/2,-(y-1)*yy/2,0])
    for (i = [1:ceil(x)])
    for (j = [1:ceil(y)])
    translate([(i-1)*sx,(j-1)*yy,0]) 
    children();
}

module pattern_circular(n=2) {
    for (i = [1:n]) 
    rotate(i*360/n) 
    children();
}

module sweep_rounded(w=10, h=10) {
    union() pattern_circular(2) {
        copy_mirror([1,0,0]) 
        translate([w/2,h/2,0])
        rotate_extrude(angle = 90, convexity = 4) 
        children();
        
        translate([w/2,0,0])
        rotate([90,0,0])
        linear_extrude(height = h, center = true)
        children();
        
        rotate([0,0,90])
        translate([h/2,0,0])
        rotate([90,0,0])
        linear_extrude(height = w, center = true)
        children();
    }
}


// ===== Pred Label Holder Modules ===== //

function pred_label_length() = Bin_Width * l_grid - 6.2;
function pred_label_center_x() = label_position_x;
function pred_label_center_y(y_end) =
    -((Bin_Depth * l_grid - 0.5) / 2)
    + y_end * ((Bin_Depth * l_grid - 0.5) / Bin_Depth)
    - pred_label_back_offset
    - (11.5 + 2 * pred_label_clearance) / 2
    + label_position_y;

module pred_label_footprint(depth, length) {
    clearance = pred_label_clearance;

    // Same footprint as gridfinity_bin_label.scad::labelbase():
    // main plate plus the narrower full-width click strip.
    union() {
        rounded_rectangle(
            length + 2 * clearance,
            11.5 + 2 * clearance,
            depth,
            0.9 + clearance
        );

        // Wider 6mm strip for the two outer snap flaps. This is 2mm wider
        // than the label body, so it sticks out 1mm at both ends.
        linear_extrude(depth)
            square([length + 2 + 2 * clearance, 6 + 2 * clearance], center = true);
    }
}

module pred_label_holder_cuts() {
    if (Label_Holder) {
        top_z = height(Bin_Height, Height_Mode, Top_Lip_Style, Snap_Height_To_Grid) + $h_base;
        label_rows = max(1, Compartments_Front_To_Back);
        compartment_depth = Bin_Depth / label_rows;

        // Pred labels only snap at their outer ends, so each compartment row
        // gets one full-width label instead of separate labels per column.
        for (j = [1:label_rows]) {
            label_length = pred_label_length();
            center_x = pred_label_center_x();
            center_y = pred_label_center_y(j * compartment_depth);

            translate([center_x, center_y, top_z - label_cut_depth - 0.02])
                pred_label_footprint(label_cut_depth + 0.04, label_length);
        }
    }
}

// ===== IMPLEMENTATION ===== //

bin_height = height(Bin_Height, Height_Mode, Top_Lip_Style, Snap_Height_To_Grid);

color(Bin_Color)
difference() {
    union() {
        gridfinity_bottom_with_cuts(Bin_Width, Bin_Depth, bin_height, Internal_Height_mm) {
            if (Compartments_Left_To_Right > 0 && Compartments_Front_To_Back > 0)
                cutEqual(n_divx = Compartments_Left_To_Right, n_divy = Compartments_Front_To_Back, style_tab = style_tab, scoop_weight = Scoop_Size);
        }

        gridfinity_top_edge(Bin_Width, Bin_Depth, bin_height);
        gridfinityBase(Bin_Width, Bin_Depth, l_grid, div_base_x, div_base_y, Base_Hole_Style, only_corners=Corner_Holes_Only);
    }

    gridfinity_top_edge_color_band(Bin_Width, Bin_Depth, bin_height);
    pred_label_holder_cuts();
}

color(Top_Edge_Color)
difference() {
    gridfinity_top_edge_color_band(Bin_Width, Bin_Depth, bin_height);
    pred_label_holder_cuts();
}