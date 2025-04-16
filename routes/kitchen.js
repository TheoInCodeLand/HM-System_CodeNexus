// routes/kitchen.js

const express = require('express');
const db = require('../database/connection'); // Adjust path as needed
const router = express.Router();

// --- Middleware (keep as is) ---
function ensureKitchenStaff(req, res, next) {
    if (req.session.user && (req.session.user.role === 'kitchen' || req.session.user.role === 'admin')) {
        return next();
    } else {
        res.redirect('/login');
    }
}
router.use(ensureKitchenStaff);

// --- GET /kitchen/dashboard (keep as is) ---
router.get('/dashboard', (req, res) => {
    // ... (dashboard logic remains unchanged) ...
    const today = new Date().toISOString().split('T')[0];
    const nearExpirySql = `SELECT id, item_name, quantity, unit, expiry_date
                           FROM inventory_items
                           WHERE expiry_date IS NOT NULL AND expiry_date >= ?
                           ORDER BY expiry_date ASC LIMIT 5`;
    const collectionSql = `SELECT waste_type, collection_day, collection_time, next_collection_due
                           FROM waste_collection_schedules
                           ORDER BY next_collection_due ASC`;

    Promise.all([
            new Promise((resolve, reject) => {
                db.all(nearExpirySql, [today], (err, items) => {
                    if (err) return reject(`Error fetching near expiry items: ${err.message}`);
                    resolve(items);
                });
            }),
            new Promise((resolve, reject) => {
                db.all(collectionSql, [], (err, schedules) => {
                    if (err) return reject(`Error fetching collection schedules: ${err.message}`);
                    resolve(schedules);
                });
            })
        ])
        .then(([nearExpiryItems, collectionSchedules]) => {
            res.render('staff/kitchen_dashboard', {
                title: 'Kitchen Dashboard',
                user: req.session.user,
                nearExpiryItems: nearExpiryItems,
                collectionSchedules: collectionSchedules
                    // *** Add logic here later if kitchen dashboard needs its own status messages ***
                    // logStatus: req.query.log_status,
                    // message: req.query.message
            });
        })
        .catch(error => {
            console.error("Error loading kitchen dashboard:", error);
            res.redirect('/');
        });
});


// --- Waste Logging Routes ---

// GET /kitchen/waste/log - Display form to log waste (This route might become less used if form is embedded elsewhere)
router.get('/waste/log', (req, res) => {
    // Pass potential error messages if redirected here
    const { log_status, message } = req.query;
    res.render('staff/kitchen_waste_log_form', {
        title: 'Log Kitchen Waste',
        user: req.session.user,
        logStatus: log_status, // Pass status to the template
        message: message // Pass message to the template
    });
});

// ***** MODIFIED SECTION *****
// POST /kitchen/waste/log - Handle waste log submission
router.post('/waste/log', (req, res) => {
    const staffUserId = req.session.user.id;
    const { waste_type, food_item, quantity, unit, reason, disposal_method } = req.body;

    // Basic Validation
    if (!waste_type || !quantity || !unit || !disposal_method) {
        console.error("Invalid input for kitchen waste log:", req.body);
        // *** MODIFIED REDIRECT: Redirect back to Housekeeping Dashboard on validation error ***
        // Use URL encoding for the message
        const message = encodeURIComponent('Invalid input. Please fill all required fields.');
        return res.redirect(`/housekeeping/dashboard?kitchen_log_status=error&kitchen_message=${message}`);
    }

    const sql = `INSERT INTO kitchen_waste_logs
                 (staff_user_id, waste_type, food_item, quantity, unit, reason, disposal_method)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`;

    db.run(sql, [staffUserId, waste_type, food_item || null, quantity, unit, reason || null, disposal_method], function(err) {
        if (err) {
            console.error("Error inserting kitchen waste log:", err.message);
            // *** MODIFIED REDIRECT: Redirect back to Housekeeping Dashboard on insert error ***
            const message = encodeURIComponent('Database error occurred while saving the log.');
            res.redirect(`/housekeeping/dashboard?kitchen_log_status=error&kitchen_message=${message}`);
        } else {
            console.log(`New kitchen waste log created with ID ${this.lastID} by user ${staffUserId}`);
            // *** MODIFIED REDIRECT: Redirect back to Housekeeping Dashboard on success ***
            const message = encodeURIComponent('Kitchen waste logged successfully!');
            res.redirect(`/housekeeping/dashboard?kitchen_log_status=success&kitchen_message=${message}`);
        }
    });
});
// ***** END OF MODIFIED SECTION *****


// GET /kitchen/waste/audit (keep as is)
router.get('/waste/audit', (req, res) => {
    // ... (audit logic remains unchanged) ...
    const sql = `SELECT waste_type, disposal_method, SUM(quantity) as total_quantity, unit
                  FROM kitchen_waste_logs
                  WHERE log_time >= date('now', '-7 days')
                  GROUP BY waste_type, disposal_method, unit
                  ORDER BY waste_type, disposal_method`;

    db.all(sql, [], (err, auditData) => {
        if (err) {
            console.error("Error fetching waste audit data:", err.message);
            return res.redirect('/kitchen/dashboard');
        }
        res.render('staff/kitchen_waste_audit', {
            title: 'Weekly Waste Audit Summary',
            user: req.session.user,
            auditData: auditData
        });
    });
});


// --- Inventory Management Routes (keep as is) ---
// GET /kitchen/inventory
// GET /kitchen/inventory/add
// POST /kitchen/inventory/add
// POST /kitchen/inventory/update/:itemId
// ... (inventory routes remain unchanged) ...
router.get('/inventory', (req, res) => {
    const { update_status, status, message } = req.query; // Read query params for status messages
    const sql = `SELECT id, item_name, category, quantity, unit, expiry_date
                 FROM inventory_items
                 ORDER BY category, item_name ASC`;
    db.all(sql, [], (err, items) => {
        if (err) {
            console.error("Error fetching inventory:", err.message);
            return res.redirect('/kitchen/dashboard');
        }
        res.render('staff/kitchen_inventory_list', {
            title: 'Kitchen Inventory',
            user: req.session.user,
            items: items,
            updateStatus: update_status, // Pass status for update actions
            addStatus: status, // Pass status for add actions
            message: message // Pass general messages
        });
    });
});
router.get('/inventory/add', (req, res) => {
    const { status, message } = req.query;
    res.render('staff/kitchen_inventory_form', {
        title: 'Add Inventory Item',
        user: req.session.user,
        item: null,
        form_action: '/kitchen/inventory/add',
        status: status,
        message: message
    });
});
router.post('/inventory/add', (req, res) => {
    const { item_name, category, quantity, unit, expiry_date } = req.body;
    if (!item_name || quantity === undefined || !unit) {
        console.error("Invalid input for new inventory item:", req.body);
        const message = encodeURIComponent('Invalid input. Name, quantity, and unit required.');
        return res.redirect(`/kitchen/inventory/add?status=error&message=${message}`);
    }
    const sql = `INSERT INTO inventory_items (item_name, category, quantity, unit, expiry_date) VALUES (?, ?, ?, ?, ?)`;
    db.run(sql, [item_name, category || null, quantity, unit, expiry_date || null], function(err) {
        if (err) {
            console.error("Error adding inventory item:", err.message);
            const message = encodeURIComponent('Database error or item already exists.');
            return res.redirect(`/kitchen/inventory/add?status=error&message=${message}`);
        }
        console.log(`New inventory item added with ID ${this.lastID}`);
        const message = encodeURIComponent('Item added successfully!');
        res.redirect(`/kitchen/inventory?status=added_success&message=${message}`); // Redirect to inventory list
    });
});
router.post('/inventory/update/:itemId', (req, res) => {
    const itemId = req.params.itemId;
    const { change_amount } = req.body;

    if (change_amount === undefined || isNaN(parseInt(change_amount))) {
        console.error("Invalid input for inventory update:", req.body);
        const message = encodeURIComponent('Invalid change amount provided.');
        return res.redirect(`/kitchen/inventory?update_status=error&message=${message}`);
    }
    const amount = parseInt(change_amount);
    const sql = `UPDATE inventory_items SET quantity = quantity + ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?`;
    db.run(sql, [amount, itemId], function(err) {
        if (err) {
            console.error(`Error updating inventory ${itemId}:`, err.message);
            const message = encodeURIComponent('Database error during update.');
            return res.redirect(`/kitchen/inventory?update_status=db_error&message=${message}`);
        }
        if (this.changes === 0) {
            console.error(`Inventory item ${itemId} not found for update.`);
            const message = encodeURIComponent(`Item ID ${itemId} not found.`);
            return res.redirect(`/kitchen/inventory?update_status=not_found&message=${message}`);
        }
        console.log(`Updated stock for inventory ID ${itemId} by ${amount}.`);
        const message = encodeURIComponent(`Stock for item ID ${itemId} updated successfully.`);
        res.redirect(`/kitchen/inventory?update_status=success&message=${message}`);
    });
});


// --- Information & Resource Routes (keep as is) ---
// GET /kitchen/guides/segregation
// GET /kitchen/guides/composting
// GET /kitchen/facilities
// GET /kitchen/recipes/scraps
// GET /kitchen/training
// ... (guide/resource routes remain unchanged) ...
router.get('/guides/segregation', (req, res) => {
    res.render('staff/kitchen_guide_segregation', {
        title: 'Waste Segregation Guide',
        user: req.session.user
    });
});
router.get('/guides/composting', (req, res) => {
    res.render('staff/kitchen_guide_composting', {
        title: 'Composting Guide',
        user: req.session.user
    });
});
router.get('/facilities', (req, res) => {
    const sql = `SELECT facility_name, address, facility_type, accepted_materials, contact_info, operating_hours FROM recycling_facilities ORDER BY facility_name ASC`;
    db.all(sql, [], (err, facilities) => {
        if (err) {
            console.error("Error fetching facilities:", err.message);
            facilities = []; // Ensure facilities is an array even on error
        }
        res.render('staff/kitchen_facilities_locator', {
            title: 'Nearby Recycling & Composting Facilities',
            user: req.session.user,
            facilities: facilities
        });
    });
});
router.get('/recipes/scraps', (req, res) => {
    res.render('staff/kitchen_scrap_recipes', {
        title: 'Food Scrap Utilization Ideas',
        user: req.session.user
    });
});
router.get('/training', (req, res) => {
    const sql = `SELECT title, description, content_url FROM staff_training_materials WHERE target_role = 'all' OR target_role = 'kitchen'`;
    db.all(sql, [], (err, materials) => {
        if (err) {
            console.error("Error fetching training materials:", err.message);
            materials = []; // Ensure materials is an array even on error
        }
        res.render('staff/kitchen_training', {
            title: 'Kitchen Staff Training',
            user: req.session.user,
            materials: materials
        });
    });
});


module.exports = router;