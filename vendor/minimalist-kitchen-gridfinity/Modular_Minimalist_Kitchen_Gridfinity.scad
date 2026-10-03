/* [Gridfinity Dimensions] */
// Width in grid units (42mm each)
width = 1; // [1:10]
// Length in grid units (42mm each)
depth = 1; // [1:10]
// Height in units (7mm each)
height = 5; // [2:10]

/* [Accessibility Settings] */
// Raising the floor makes small items like chopsticks or butter knives easier to grab
floor_thickness = 0; // [0:0.5:40]
// Larger radius creates a better "scoop" for sliding items out
inner_radius = 25; // [10:35]

/* [Grid Configuration] */
// Number of internal compartments (X)
compartments_x = 1; // [1:5]
// Number of internal compartments (Y)
compartments_y = 1; // [1:5]

/* [Advanced Parameters] */
border = 6;
margin = 3;
gridfinity_dim = 42; 
$fn=64;

// --- MAIN GENERATION LOGIC ---

difference() {
    // Generate the main block using the module defined below
    translate([gridfinity_dim / 2, gridfinity_dim / 2, 0]) 
    grid_block(
        num_x = width, 
        num_y = depth, 
        num_z = height, 
        magnet_diameter=0,
        stackable=false,
        screw_depth=0
    );

    // Calculate internal dimensions
    compartment_width = ((width * gridfinity_dim) - 2 * border - (compartments_x - 1) * margin) / compartments_x;
    compartment_depth = ((depth * gridfinity_dim) - 2 * border - (compartments_y - 1) * margin) / compartments_y;
    
    // Generate the raised compartments
    for (x = [0:compartments_x - 1]) {
        for (y = [0:compartments_y - 1]) {
            translate([
                border + x * (compartment_width + margin), 
                border + y * (compartment_depth + margin), 
                7 + floor_thickness
            ]) {
                compartment(
                    compartment_width, 
                    compartment_depth, 
                    (height * 7 + 11.4) - floor_thickness, 
                    inner_radius
                );
            }
        }
    }
}

module compartment(width, depth, height, d) {
    translate([d / 2, d / 2, d / 2]) minkowski() {
        sphere(d = inner_radius);
        cube([
            max(0.1, width - d), 
            max(0.1, depth - d), 
            max(0.1, height - d)
        ]);
    }
}

// --- STANDALONE LIBRARY MODULES (Merged from lib) ---

gridfinity_pitch = 42;
gridfinity_zpitch = 7;
gridfinity_clearance = 0.5;
sharp_corners = 0;

module grid_block(num_x=1, num_y=1, num_z=2, magnet_diameter=6.5, screw_depth=6, center=false, hole_overhang_remedy=false, half_pitch=false, box_corner_attachments_only = false, stackable = true) {
  corner_radius = 3.75;
  outer_size = gridfinity_pitch - gridfinity_clearance;
  block_corner_position = outer_size/2 - corner_radius;
  magnet_thickness = 2.4;
  magnet_position = min(gridfinity_pitch/2-8, gridfinity_pitch/2-4-magnet_diameter/2);
  screw_hole_diam = 3;
  gp = gridfinity_pitch;
  
  suppress_holes = num_x < 1 || num_y < 1;
  emd = suppress_holes ? 0 : magnet_diameter; 
  esd = suppress_holes ? 0 : screw_depth;     
  
  overhang_fix = hole_overhang_remedy && emd > 0 && esd > 0;
  overhang_fix_depth = 0.3;
  
  totalht=gridfinity_zpitch*num_z+3.75;
  translate( center ? [-(num_x-1)*gridfinity_pitch/2, -(num_y-1)*gridfinity_pitch/2, 0] : [0, 0, 0] )
  difference() {
    intersection() {
      union() {
        pad_grid(num_x, num_y, half_pitch);
        translate([-gridfinity_pitch/2, -gridfinity_pitch/2, 5]) 
        cube([gridfinity_pitch*num_x, gridfinity_pitch*num_y, totalht-5]);
      }
      translate([0, 0, -0.1])
      hull() 
      cornercopy(block_corner_position, num_x, num_y) 
      cylinder(r=corner_radius, h=totalht+0.2, $fn=32);
    }
    
    if (stackable) {
      color("blue") 
      translate([0, 0, gridfinity_zpitch*num_z]) 
      pad_oversize(num_x, num_y, 1);
    }
    
    if (esd > 0) {
      gridcopycorners(ceil(num_x), ceil(num_y), magnet_position, box_corner_attachments_only)
      translate([0, 0, -0.1]) cylinder(d=screw_hole_diam, h=esd+0.1, $fn=28);
    }
    
    if (emd > 0) {
      gridcopycorners(ceil(num_x), ceil(num_y), magnet_position, box_corner_attachments_only)
      translate([0, 0, -0.1]) cylinder(d=emd, h=magnet_thickness+0.1, $fn=41);
    }
  }
}

module pad_grid(num_x, num_y, half_pitch=false) {
  cut_far_x = (num_x < 1 && !half_pitch) || (num_x < 0.5);
  cut_far_y = (num_y < 1 && !half_pitch) || (num_y < 0.5);
  
  gridcopy(ceil(num_x), ceil(num_y)) intersection() {
    pad_oversize();
    if (cut_far_x) translate([gridfinity_pitch*(-1+num_x), 0, 0]) pad_oversize();
    if (cut_far_y) translate([0, gridfinity_pitch*(-1+num_y), 0]) pad_oversize();
    if (cut_far_x && cut_far_y) translate([gridfinity_pitch*(-1+num_x), gridfinity_pitch*(-1+num_y), 0]) pad_oversize();
  }
}

module pad_oversize(num_x=1, num_y=1, margins=0) {
  pad_corner_position = gridfinity_pitch/2 - 4;
  bevel1_top = 0.8;
  bevel2_bottom = 2.6;
  bevel2_top = 5;
  bonus_ht = 0.2;
  radialgap = margins ? 0.25 : 0;
  axialdown = margins ? 0.1 : 0;
  
  translate([0, 0, -axialdown])
  difference() {
    union() {
      hull() cornercopy(pad_corner_position, num_x, num_y) {
        cylinder(d=1.6+2*radialgap, h=0.1, $fn=24);
        translate([0, 0, bevel1_top]) cylinder(d=3.2+2*radialgap, h=1.9, $fn=32);
      }
      hull() cornercopy(pad_corner_position, num_x, num_y) {
        translate([0, 0, bevel2_bottom]) 
        cylinder(d1=3.2+2*radialgap, d2=7.5+0.5+2*radialgap+2*bonus_ht, h=bevel2_top-bevel2_bottom+bonus_ht, $fn=32);
      }
    }
    if (margins) {
      translate([-gridfinity_pitch/2, -gridfinity_pitch/2, 0])
      cube([gridfinity_pitch*num_x, gridfinity_pitch*num_y, axialdown]);
    }
  }
}

module gridcopycorners(num_x, num_y, r, onlyBoxCorners = false) {
  for (xi=[1:num_x]) for (yi=[1:num_y]) 
    for (xx=[-1, 1]) for (yy=[-1, 1]) 
      if(!onlyBoxCorners || (xi == 1 && yi == 1 && xx == -1 && yy == -1) || (xi == num_x && yi == num_y && xx == 1 && yy == 1) || (xi == 1 && yi == num_y && xx == -1 && yy == 1) || (xi == num_x && yi == 1 && xx == 1 && yy == -1))  
        translate([gridfinity_pitch*(xi-1), gridfinity_pitch*(yi-1), 0]) 
        translate([xx*r, yy*r, 0]) children();
}

module cornercopy(r, num_x=1, num_y=1) {
  for (xx=[-r, gridfinity_pitch*(num_x-1)+r]) for (yy=[-r, gridfinity_pitch*(num_y-1)+r]) 
    translate([xx, yy, 0]) children();
}

module gridcopy(num_x, num_y) {
  for (xi=[1:num_x]) for (yi=[1:num_y]) translate([gridfinity_pitch*(xi-1), gridfinity_pitch*(yi-1), 0]) children();
}