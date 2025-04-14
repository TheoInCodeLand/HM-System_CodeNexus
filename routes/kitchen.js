const express = require('express');
const db = require('../database/connection'); // Adjust path as needed
const router = express.Router();

// --- Middleware to ensure user is logged in as Kitchen Staff (or Admin) ---
function ensureKitchenStaff(req, res, next) {
    if (req.session.user && (req.session.user.role === 'kitchen' || req.session.user.role === 'admin')) {
        return next();
    } else {
        // Redirect to login if not authorized
        res.redirect('/login');
    }
}

// Apply the middleware to all routes in this file
router.use(ensureKitchenStaff);

// --- GET /kitchen/dashboard ---
// Shows a dashboard for kitchen staff.
router.get('/dashboard', (req, res) => {
    // Example: Fetch items nearing expiry (FIFO reminder) [cite: 22]
    // Fetch upcoming waste collections [cite: 19]
    const today = new Date().toISOString().split('T')[0];
    const nearExpirySql = `SELECT id, item_name, quantity, unit, expiry_date
                           FROM inventory_items
                           WHERE expiry_date IS NOT NULL AND expiry_date >= ?
                           ORDER BY expiry_date ASC LIMIT 5`; // Show soonest expiring items

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
        res.render('staff/kitchen_dashboard', { // Assumes views/staff/kitchen_dashboard.ejs
            title: 'Kitchen Dashboard',
            user: req.session.user,
            nearExpiryItems: nearExpiryItems,
            collectionSchedules: collectionSchedules
        });
    })
    .catch(error => {
        console.error("Error loading kitchen dashboard:", error);
        res.redirect('/'); // Redirect home on error
    });
});

// --- Waste Logging Routes [cite: 21, 23] ---

// GET /kitchen/waste/log - Display form to log waste
router.get('/waste/log', (req, res) => {
    res.render('staff/kitchen_waste_log_form', { // Assumes views/staff/kitchen_waste_log_form.ejs
        title: 'Log Kitchen Waste',
        user: req.session.user
    });
});

// POST /kitchen/waste/log - Handle waste log submission
router.post('/waste/log', (req, res) => {
    const staffUserId = req.session.user.id;
    const { waste_type, food_item, quantity, unit, reason, disposal_method } = req.body;

    // Basic Validation
    if (!waste_type || !quantity || !unit || !disposal_method) {
        console.error("Invalid input for kitchen waste log:", req.body);
        return res.redirect('/kitchen/waste/log?log_status=error&message=InvalidInput');
    }

    const sql = `INSERT INTO kitchen_waste_logs
                 (staff_user_id, waste_type, food_item, quantity, unit, reason, disposal_method)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`;

    db.run(sql, [staffUserId, waste_type, food_item || null, quantity, unit, reason || null, disposal_method], function(err) {
        if (err) {
            console.error("Error inserting kitchen waste log:", err.message);
             res.redirect('/kitchen/waste/log?log_status=error&message=InsertFailed');
        } else {
            console.log(`New kitchen waste log created with ID ${this.lastID} by user ${staffUserId}`);
            res.redirect('/kitchen/dashboard?log_status=waste_success'); // Redirect to dashboard
        }
    });
});

// GET /kitchen/waste/audit - Display waste audit data (example: summary) [cite: 23]
router.get('/waste/audit', (req,res) => {
    // Example: Sum waste by type for a period (e.g., last 7 days)
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
         res.render('staff/kitchen_waste_audit', { // Assumes views/staff/kitchen_waste_audit.ejs
            title: 'Weekly Waste Audit Summary',
            user: req.session.user,
            auditData: auditData
         });
    });
});


// --- Inventory Management Routes [cite: 22] ---

// GET /kitchen/inventory - Display inventory list
router.get('/inventory', (req, res) => {
    const sql = `SELECT id, item_name, category, quantity, unit, expiry_date
                 FROM inventory_items
                 ORDER BY category, item_name ASC`;
    db.all(sql, [], (err, items) => {
        if (err) {
            console.error("Error fetching inventory:", err.message);
            return res.redirect('/kitchen/dashboard');
        }
        res.render('staff/kitchen_inventory_list', { // Assumes views/staff/kitchen_inventory_list.ejs
            title: 'Kitchen Inventory',
            user: req.session.user,
            items: items
        });
    });
});

// GET /kitchen/inventory/add - Display form to add inventory item
router.get('/inventory/add', (req, res) => {
     res.render('staff/kitchen_inventory_form', { // Assumes views/staff/kitchen_inventory_form.ejs
        title: 'Add Inventory Item',
        user: req.session.user,
        item: null, // Indicate adding new item
        form_action: '/kitchen/inventory/add'
    });
});

// POST /kitchen/inventory/add - Handle adding new inventory item
router.post('/inventory/add', (req, res) => {
    const { item_name, category, quantity, unit, expiry_date } = req.body;
     if (!item_name || quantity === undefined || !unit) {
         console.error("Invalid input for new inventory item:", req.body);
         return res.redirect('/kitchen/inventory/add?status=error&message=InvalidInput');
     }
     const sql = `INSERT INTO inventory_items (item_name, category, quantity, unit, expiry_date) VALUES (?, ?, ?, ?, ?)`;
     db.run(sql, [item_name, category || null, quantity, unit, expiry_date || null], function(err) {
         if (err) {
             console.error("Error adding inventory item:", err.message);
             // Handle unique constraint error etc.
             return res.redirect('/kitchen/inventory/add?status=error&message=InsertFailed');
         }
         console.log(`New inventory item added with ID ${this.lastID}`);
         res.redirect('/kitchen/inventory?status=added_success');
     });
});

// POST /kitchen/inventory/update/:itemId - Update stock level (example: simple adjustment)
router.post('/inventory/update/:itemId', (req, res) => {
    const itemId = req.params.itemId;
    const { change_amount } = req.body; // Expect amount to add/subtract

    if (change_amount === undefined || isNaN(parseInt(change_amount))) {
        console.error("Invalid input for inventory update:", req.body);
        return res.redirect('/kitchen/inventory?update_status=error');
    }
    const amount = parseInt(change_amount);
    const sql = `UPDATE inventory_items SET quantity = quantity + ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?`;
    db.run(sql, [amount, itemId], function(err) {
        if (err) {
             console.error(`Error updating inventory ${itemId}:`, err.message);
             return res.redirect('/kitchen/inventory?update_status=db_error');
        }
        if (this.changes === 0) {
             console.error(`Inventory item ${itemId} not found for update.`);
             return res.redirect('/kitchen/inventory?update_status=not_found');
        }
         console.log(`Updated stock for inventory ID ${itemId} by ${amount}.`);
         res.redirect('/kitchen/inventory?update_status=success');
    });
});

// --- Information & Resource Routes ---

// GET /kitchen/guides/segregation - Display waste segregation guide [cite: 18]
router.get('/guides/segregation', (req, res) => {
    // Content could be hardcoded, fetched from DB (e.g., tips_alerts table with category 'segregation'), or a static file
     res.render('staff/kitchen_guide_segregation', { // Assumes views/staff/kitchen_guide_segregation.ejs
        title: 'Waste Segregation Guide',
        user: req.session.user
    });
});

// GET /kitchen/guides/composting - Display composting guide [cite: 23]
router.get('/guides/composting', (req, res) => {
    res.render('staff/kitchen_guide_composting', { // Assumes views/staff/kitchen_guide_composting.ejs
        title: 'Composting Guide',
        user: req.session.user
    });
});

// GET /kitchen/facilities - Display recycling locator info [cite: 19]
router.get('/facilities', (req, res) => {
    const sql = `SELECT facility_name, address, facility_type, accepted_materials, contact_info, operating_hours FROM recycling_facilities ORDER BY facility_name ASC`;
    db.all(sql, [], (err, facilities) => {
        if(err){
            console.error("Error fetching facilities:", err.message);
            facilities = [];
        }
         res.render('staff/kitchen_facilities_locator', { // Assumes views/staff/kitchen_facilities_locator.ejs
            title: 'Nearby Recycling & Composting Facilities',
            user: req.session.user,
            facilities: facilities
        });
    });
});

// GET /kitchen/recipes/scraps - Display scrap utilization ideas [cite: 22]
router.get('/recipes/scraps', (req, res) => {
     // Fetch from DB or serve static content
     res.render('staff/kitchen_scrap_recipes', { // Assumes views/staff/kitchen_scrap_recipes.ejs
        title: 'Food Scrap Utilization Ideas',
        user: req.session.user
        // Pass recipe ideas data if fetched
    });
});

// GET /kitchen/training - Display links to training materials [cite: 23]
router.get('/training', (req, res) => {
     const sql = `SELECT title, description, content_url FROM staff_training_materials WHERE target_role = 'all' OR target_role = 'kitchen'`;
     db.all(sql, [], (err, materials) => {
         if(err){
            console.error("Error fetching training materials:", err.message);
            materials = [];
        }
         res.render('staff/kitchen_training', { // Assumes views/staff/kitchen_training.ejs
            title: 'Kitchen Staff Training',
            user: req.session.user,
            materials: materials
        });
     });
});


module.exports = router;