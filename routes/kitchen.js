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

// --- GET /kitchen/dashboard ---
router.get('/dashboard', (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const { log_status, message } = req.query;

    // --- SQL Queries ---
    const nearExpirySql = `SELECT id, item_name, quantity, unit, expiry_date FROM inventory_items WHERE expiry_date IS NOT NULL AND expiry_date >= ? ORDER BY expiry_date ASC LIMIT 5`;
    const collectionSql = `SELECT waste_type, collection_day, collection_time, next_collection_due FROM waste_collection_schedules ORDER BY next_collection_due ASC`;
    const recentWasteSql = `SELECT log_id, log_time, waste_type, food_item, quantity, unit FROM kitchen_waste_logs ORDER BY log_time DESC LIMIT 5`;
    const weeklyWasteSummarySql = `SELECT waste_type, SUM(quantity) as total_quantity, unit FROM kitchen_waste_logs WHERE log_time >= date('now', '-7 days') GROUP BY waste_type, unit ORDER BY total_quantity DESC`;

    // *** UPDATED Low Stock SQL based on quantity <= 5 ***
    const lowStockSql = `SELECT id, item_name, quantity, unit FROM inventory_items WHERE quantity <= 5 ORDER BY item_name ASC LIMIT 5`; // Changed condition here

    // --- Fetch Data using Promise.all ---
    Promise.all([
            // Promise 1: Near Expiry
            new Promise((resolve, reject) => {
                db.all(nearExpirySql, [today], (err, items) => {
                    if (err) return reject(`Error fetching near expiry items: ${err.message}`);
                    resolve(items || []);
                });
            }),
            // Promise 2: Collection Schedules
            new Promise((resolve, reject) => {
                db.all(collectionSql, [], (err, schedules) => {
                    if (err) return reject(`Error fetching collection schedules: ${err.message}`);
                    resolve(schedules || []);
                });
            }),
            // Promise 3: Recent Waste Logs
            new Promise((resolve, reject) => {
                db.all(recentWasteSql, [], (err, logs) => {
                    if (err) return reject(`Error fetching recent waste logs: ${err.message}`);
                    resolve(logs || []);
                });
            }),
            // Promise 4: Weekly Waste Summary
            new Promise((resolve, reject) => {
                db.all(weeklyWasteSummarySql, [], (err, summary) => {
                    if (err) return reject(`Error fetching weekly waste summary: ${err.message}`);
                    resolve(summary || []);
                });
            }),
            // Promise 5: Low Stock Items (using updated definition)
            new Promise((resolve, reject) => {
                db.all(lowStockSql, [], (err, items) => { // Uses the updated lowStockSql query
                    if (err) {
                        console.error("Error fetching low stock items:", err.message); // Log full error
                        // Return empty array to avoid crashing, but log the error
                        return resolve([]);
                        // Alternatively, reject if low stock is critical:
                        // return reject(`Error fetching low stock items: ${err.message}`);
                    }
                    resolve(items || []);
                });
            })
        ])
        .then(([nearExpiryItems, collectionSchedules, recentWasteLogs, wasteSummaryData, lowStockItems]) => {
            // --- Render the dashboard ---
            res.render('staff/kitchen_dashboard', {
                title: 'Kitchen Dashboard',
                user: req.session.user,
                nearExpiryItems: nearExpiryItems,
                collectionSchedules: collectionSchedules,
                recentWasteLogs: recentWasteLogs,
                wasteSummaryData: wasteSummaryData,
                lowStockItems: lowStockItems, // Pass the fetched low stock items (now based on quantity <= 5)
                logStatus: log_status,
                message: message
            });
        })
        .catch(error => {
            console.error("Error loading kitchen dashboard:", error);
            res.status(500).send("Error loading kitchen dashboard data.");
        });
});
// --- ***** END OF UPDATED DASHBOARD ROUTE ***** ---


// --- Waste Logging Routes (Keep as is, except for removing duplicate POST below) ---
router.get('/waste/log', (req, res) => {
    const { log_status, message } = req.query;
    // Assuming your render call has necessary parameters
    res.render('staff/kitchen_waste_log_form', {
        title: 'Log Kitchen Waste',
        user: req.session.user,
        logStatus: log_status,
        message: message
    });
});

router.post('/waste/log', (req, res) => {
    // Using the version that redirects to kitchen dashboard
    const staffUserId = req.session.user.id; // Make sure staffUserId is used in the SQL if needed
    const { waste_type, food_item, quantity, unit, reason, disposal_method } = req.body;

    if (!waste_type || !quantity || !unit || !disposal_method || quantity <= 0) { // Added quantity > 0 check
        const message = encodeURIComponent('Invalid input. Waste type, positive quantity, unit, and disposal method are required.');
        // Redirect back to the form or dashboard with error
        // Choose one: redirect back to form or dashboard
        // Option 1: Redirect back to form
        // return res.redirect(`/kitchen/waste/log?log_status=error&message=${message}`);
        // Option 2: Redirect to dashboard
        return res.redirect(`/kitchen/dashboard?log_status=error&message=${message}`);
    }

    const sql = `INSERT INTO kitchen_waste_logs
                 (staff_user_id, waste_type, food_item, quantity, unit, reason, disposal_method, log_time)
                 VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`;
    // Ensure parameter order matches SQL statement
    db.run(sql, [staffUserId, waste_type, food_item || null, quantity, unit, reason || null, disposal_method], function(err) {
        if (err) {
            console.error("Error logging kitchen waste:", err.message);
            const message = encodeURIComponent('Database error occurred while logging waste.');
            // Redirect to dashboard with error message
            res.redirect(`/kitchen/dashboard?log_status=db_error&message=${message}`);
        } else {
            console.log(`Kitchen waste logged with ID ${this.lastID}`);
            const message = encodeURIComponent('Kitchen waste logged successfully!');
            res.redirect(`/kitchen/dashboard`); // Redirect to kitchen dashboard
        }
    });
});
// ***** END OF WASTE LOGGING SECTION *****

// GET /kitchen/waste/audit (keep as is)
router.get('/waste/audit', (req, res) => {
    const sql = `SELECT waste_type, disposal_method, SUM(quantity) as total_quantity, unit
                 FROM kitchen_waste_logs
                 WHERE log_time >= date('now', '-7 days')
                 GROUP BY waste_type, disposal_method, unit
                 ORDER BY waste_type, disposal_method`;

    db.all(sql, [], (err, auditData) => {
        if (err) {
            console.error("Error fetching waste audit data:", err.message);
            // Redirect to dashboard with an error message if needed, or just render with empty data
            res.render('staff/kitchen_waste_audit', {
                title: 'Weekly Waste Audit Summary',
                user: req.session.user,
                auditData: [], // Send empty array on error
                errorMessage: "Could not load waste audit data."
            });
            // return res.redirect('/kitchen/dashboard'); // Alternative: Redirect
        } else {
            res.render('staff/kitchen_waste_audit', {
                title: 'Weekly Waste Audit Summary',
                user: req.session.user,
                auditData: auditData
            });
        }
    });
});


// --- Inventory Management Routes ---

// *** UPDATED GET /kitchen/inventory route to add stock_status ***
router.get('/inventory', (req, res) => {
    const { update_status, status, message } = req.query;
    const sql = `SELECT id, item_name, category, quantity, unit, expiry_date, reorder_level, last_updated
                 FROM inventory_items ORDER BY category, item_name ASC`; // Added last_updated

    db.all(sql, [], (err, items) => {
        if (err) {
            console.error("Error fetching inventory list:", err.message);
            // Render the page with an error message and empty list
            return res.render('staff/kitchen_inventory_list', {
                title: 'Kitchen Inventory',
                user: req.session.user,
                items: [], // Send empty array on error
                errorMessage: 'Failed to load inventory items.',
                updateStatus: update_status,
                addStatus: status,
                message: message
            });
        }

        // *** Add stock_status logic here ***
        const itemsWithStatus = items.map(item => {
            let stockStatus;
            if (item.quantity === null || item.quantity === undefined) {
                stockStatus = 'Unknown'; // Handle cases where quantity might be null
            } else if (item.quantity <= 5) {
                stockStatus = 'Low Stock';
            } else {
                stockStatus = 'Normal';
            }
            return {
                ...item, // Spread existing item properties
                stock_status: stockStatus // Add the new status property
            };
        });
        // *** End of stock_status logic ***

        res.render('staff/kitchen_inventory_list', {
            title: 'Kitchen Inventory',
            user: req.session.user,
            items: itemsWithStatus, // Pass the array with the added status
            updateStatus: update_status,
            addStatus: status,
            message: message,
            errorMessage: null // No error if we reached here
        });
    });
});
// *** END OF UPDATED GET /kitchen/inventory route ***

router.get('/inventory/add', (req, res) => {
    const { status, message } = req.query;
    res.render('staff/kitchen_inventory_form', {
        title: 'Add Inventory Item',
        user: req.session.user,
        item: null, // No existing item for add form
        form_action: '/kitchen/inventory/add',
        status: status,
        message: message
    });
});

// *** KEEPS the updated POST /inventory/add route that includes reorder_level ***
router.post('/inventory/add', (req, res) => {
    // Destructure reorder_level from req.body
    const { item_name, category, quantity, unit, expiry_date, reorder_level } = req.body;

    // Validate required fields and quantity > 0
    if (!item_name || quantity === undefined || quantity === '' || !unit || parseFloat(quantity) < 0) {
        console.error("Invalid input for new inventory item:", req.body);
        const message = encodeURIComponent('Invalid input. Name, non-negative quantity, and unit required.');
        return res.redirect(`/kitchen/inventory/add?status=error&message=${message}`);
    }

    // Validate reorder_level if provided (must be non-negative number)
    let reorderLevelValue = null;
    if (reorder_level !== undefined && reorder_level !== '') {
        if (isNaN(parseFloat(reorder_level)) || parseFloat(reorder_level) < 0) {
            const message = encodeURIComponent('Invalid input. Reorder level must be a non-negative number.');
            return res.redirect(`/kitchen/inventory/add?status=error&message=${message}`);
        }
        reorderLevelValue = parseFloat(reorder_level);
    }


    const sql = `INSERT INTO inventory_items
                 (item_name, category, quantity, unit, expiry_date, reorder_level, last_updated)
                 VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`; // Added reorder_level placeholder and last_updated

    db.run(sql, [
        item_name,
        category || null,
        parseFloat(quantity), // Ensure quantity is stored as a number
        unit,
        expiry_date || null,
        reorderLevelValue // Use the validated or null value
    ], function(err) {
        if (err) {
            console.error("Error adding inventory item:", err.message);
            // Check for unique constraint error (example: UNIQUE constraint failed: inventory_items.item_name)
            const message = encodeURIComponent(err.message.includes('UNIQUE constraint') ? 'Item name already exists.' : 'Database error occurred.');
            return res.redirect(`/kitchen/inventory/add?status=error&message=${message}`);
        }
        console.log(`New inventory item added with ID ${this.lastID}`);
        const message = encodeURIComponent('Item added successfully!');
        // Redirect to inventory list with success message
        res.redirect(`/kitchen/inventory?status=added_success&message=${message}`);
    });
});
// *** END OF UPDATED POST /inventory/add route ***

// --- REMOVED the duplicate, simpler POST /inventory/add route ---

// POST /kitchen/inventory/update/:itemId (keep as is, maybe add validation for negative result?)
router.post('/inventory/update/:itemId', (req, res) => {
    const itemId = req.params.itemId;
    const { change_amount } = req.body;

    // Validate input: change_amount must be a valid number (can be negative)
    if (change_amount === undefined || change_amount === '' || isNaN(parseFloat(change_amount))) {
        console.error("Invalid input for inventory update:", req.body);
        const message = encodeURIComponent('Invalid change amount provided. Please enter a number.');
        return res.redirect(`/kitchen/inventory?update_status=error&message=${message}&itemId=${itemId}`); // Redirect back to list
    }

    const amount = parseFloat(change_amount);

    // Optional: Check if the update would result in a negative quantity (depends on business logic)
    // db.get('SELECT quantity FROM inventory_items WHERE id = ?', [itemId], (err, item) => {
    //     if (err) { /* handle error */ }
    //     if (!item) { /* handle not found */ }
    //     if (item.quantity + amount < 0) {
    //          const message = encodeURIComponent(`Update failed: Cannot have negative stock for item ID ${itemId}.`);
    //          return res.redirect(`/kitchen/inventory?update_status=negative_stock&message=${message}&itemId=${itemId}`);
    //     }
    // If check passes, proceed with the update
    const sql = `UPDATE inventory_items SET quantity = quantity + ?, last_updated = CURRENT_TIMESTAMP WHERE id = ?`;
    db.run(sql, [amount, itemId], function(err) {
        if (err) {
            console.error(`Error updating inventory ${itemId}:`, err.message);
            const message = encodeURIComponent('Database error during update.');
            return res.redirect(`/kitchen/inventory?update_status=db_error&message=${message}&itemId=${itemId}`);
        }
        if (this.changes === 0) {
            console.error(`Inventory item ${itemId} not found for update.`);
            const message = encodeURIComponent(`Item ID ${itemId} not found.`);
            return res.redirect(`/kitchen/inventory?update_status=not_found&message=${message}`);
        }
        console.log(`Updated stock for inventory ID ${itemId} by ${amount}. New quantity calculated in DB.`);
        const message = encodeURIComponent(`Stock for item ID ${itemId} updated successfully.`);
        res.redirect(`/kitchen/inventory?update_status=success&message=${message}`);
    });
    // }); // End of optional negative check wrapper
});


// --- Information & Resource Routes (keep as is) ---
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