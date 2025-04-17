// routes/kitchen.js

const express = require('express');
const db = require('../database/connection'); // Adjust path as needed
const router = express.Router();

// --- Middleware ---
function ensureKitchenStaff(req, res, next) {
    if (req.session.user && (req.session.user.role === 'kitchen' || req.session.user.role === 'admin')) {
        return next();
    } else {
        // Store the originally requested URL in the session
        req.session.returnTo = req.originalUrl;
        res.redirect('/login');
    }
}
// Apply middleware to all routes in this file
router.use(ensureKitchenStaff);

// --- GET /kitchen/dashboard ---
router.get('/dashboard', (req, res) => {
    // Calculate today and tomorrow's date strings in YYYY-MM-DD format
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    const todayStr = today.toISOString().split('T')[0];
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    // Get status messages from query parameters
    const { log_status, message, action_status } = req.query;

    // --- SQL Queries ---
    // Near Expiry (general next 5, might overlap with Expiring Soon)
    const nearExpirySql = `
        SELECT id, item_name, quantity, unit, expiry_date
        FROM inventory_items
        WHERE expiry_date IS NOT NULL AND expiry_date >= ? AND quantity > 0
        ORDER BY expiry_date ASC
        LIMIT 5`;

    // Collection Schedules
    const collectionSql = `
        SELECT waste_type, collection_day, collection_time, next_collection_due
        FROM waste_collection_schedules
        ORDER BY next_collection_due ASC`;

    // Recent Waste Logs
    const recentWasteSql = `
        SELECT log_id, log_time, waste_type, food_item, quantity, unit
        FROM kitchen_waste_logs
        ORDER BY log_time DESC
        LIMIT 5`;

    // Weekly Waste Summary
    const weeklyWasteSummarySql = `
        SELECT waste_type, SUM(quantity) as total_quantity, unit
        FROM kitchen_waste_logs
        WHERE log_time >= date('now', '-7 days')
        GROUP BY waste_type, unit
        ORDER BY total_quantity DESC`;

    // Low Stock Items (Quantity <= 5)
    const lowStockSql = `
        SELECT id, item_name, quantity, unit
        FROM inventory_items
        WHERE quantity <= 5 AND quantity > 0
        ORDER BY item_name ASC
        LIMIT 5`;

    // Items expiring today or tomorrow (Action Required)
    const expiringSoonSql = `
        SELECT id, item_name, quantity, unit, expiry_date
        FROM inventory_items
        WHERE expiry_date IS NOT NULL
          AND expiry_date >= ?        -- Expires today or later
          AND expiry_date <= ?        -- Expires tomorrow or sooner
          AND quantity > 0            -- Only show items that actually exist
        ORDER BY expiry_date ASC, item_name ASC`;

    // --- Fetch Data using Promise.all ---
    Promise.all([
            // Promise 1: Near Expiry
            new Promise((resolve, reject) => {
                db.all(nearExpirySql, [todayStr], (err, items) => {
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
            // Promise 5: Low Stock Items
            new Promise((resolve, reject) => {
                db.all(lowStockSql, [], (err, items) => {
                    if (err) {
                        console.error("Error fetching low stock items:", err.message);
                        return resolve([]); // Return empty array on error
                    }
                    resolve(items || []);
                });
            }),
            // Promise 6: Expiring Soon Items (Action Required)
            new Promise((resolve, reject) => {
                db.all(expiringSoonSql, [todayStr, tomorrowStr], (err, items) => {
                    if (err) {
                        console.error("Error fetching expiring soon items:", err.message);
                        return resolve([]); // Return empty array on error
                    }
                    resolve(items || []);
                });
            })
        ])
        // Destructure all results
        .then(([nearExpiryItems, collectionSchedules, recentWasteLogs, wasteSummaryData, lowStockItems, expiringSoonItems]) => {
            // --- Render the dashboard ---
            res.render('staff/kitchen_dashboard', {
                title: 'Kitchen Dashboard',
                user: req.session.user,
                nearExpiryItems: nearExpiryItems,
                collectionSchedules: collectionSchedules,
                recentWasteLogs: recentWasteLogs,
                wasteSummaryData: wasteSummaryData,
                lowStockItems: lowStockItems,
                expiringSoonItems: expiringSoonItems, // Items needing action
                logStatus: log_status, // For general waste log feedback
                message: message, // Feedback message content
                actionStatus: action_status // For expiring item action feedback
            });
        })
        .catch(error => {
            console.error("Error loading kitchen dashboard:", error);
            res.status(500).render('error', { // Render an error page if possible
                message: 'Error loading kitchen dashboard data.',
                error: process.env.NODE_ENV === 'development' ? error : {} // Show details in dev
            });
            // res.status(500).send("Error loading kitchen dashboard data."); // Fallback
        });
});

// --- Waste Logging Routes ---

// GET /kitchen/waste/log - Display form (Might be embedded in dashboard now)
router.get('/waste/log', (req, res) => {
    const { log_status, message } = req.query;
    res.render('staff/kitchen_waste_log_form', {
        title: 'Log Kitchen Waste',
        user: req.session.user,
        logStatus: log_status,
        message: message
    });
});

// POST /kitchen/waste/log - Handle general waste logging submission
router.post('/waste/log', (req, res) => {
    const staffUserId = req.session.user.id;
    const { waste_type, food_item, quantity, unit, reason, disposal_method } = req.body;

    // Validation
    if (!waste_type || !quantity || !unit || !disposal_method || parseFloat(quantity) <= 0) {
        const message = encodeURIComponent('Invalid input. Waste type, positive quantity, unit, and disposal method are required.');
        // Redirect to dashboard with error (as form might be embedded)
        return res.redirect(`/kitchen/dashboard?log_status=error&message=${message}`);
    }

    const sql = `INSERT INTO kitchen_waste_logs
                 (staff_user_id, waste_type, food_item, quantity, unit, reason, disposal_method, log_time)
                 VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`;

    db.run(sql, [staffUserId, waste_type, food_item || null, parseFloat(quantity), unit, reason || null, disposal_method], function(err) {
        if (err) {
            console.error("Error logging kitchen waste:", err.message);
            const message = encodeURIComponent('Database error occurred while logging waste.');
            res.redirect(`/kitchen/dashboard?log_status=db_error&message=${message}`);
        } else {
            console.log(`Kitchen waste logged with ID ${this.lastID}`);
            const message = encodeURIComponent('Kitchen waste logged successfully!');
            res.redirect(`/kitchen/dashboard?log_status=success&message=${message}`);
        }
    });
});

// GET /kitchen/waste/audit - Display weekly waste audit
router.get('/waste/audit', (req, res) => {
    const sql = `SELECT waste_type, disposal_method, SUM(quantity) as total_quantity, unit
                 FROM kitchen_waste_logs
                 WHERE log_time >= date('now', '-7 days')
                 GROUP BY waste_type, disposal_method, unit
                 ORDER BY waste_type, disposal_method`;

    db.all(sql, [], (err, auditData) => {
        let errorMessage = null;
        if (err) {
            console.error("Error fetching waste audit data:", err.message);
            errorMessage = "Could not load waste audit data.";
        }
        res.render('staff/kitchen_waste_audit', {
            title: 'Weekly Waste Audit Summary',
            user: req.session.user,
            auditData: auditData || [], // Ensure auditData is an array
            errorMessage: errorMessage
        });
    });
});


// --- Inventory Management Routes ---

// GET /kitchen/inventory - Display inventory list with stock status
router.get('/inventory', (req, res) => {
    const { update_status, status, message } = req.query; // Status from add/update actions
    const sql = `SELECT id, item_name, category, quantity, unit, expiry_date, reorder_level, last_updated
                 FROM inventory_items ORDER BY category, item_name ASC`;

    db.all(sql, [], (err, items) => {
        let errorMessage = null;
        let itemsWithStatus = [];

        if (err) {
            console.error("Error fetching inventory list:", err.message);
            errorMessage = 'Failed to load inventory items.';
        } else {
            // Add stock_status logic
            itemsWithStatus = (items || []).map(item => {
                let stockStatus;
                if (item.quantity === null || item.quantity === undefined) {
                    stockStatus = 'Unknown';
                } else if (item.quantity <= 5) {
                    stockStatus = 'Low Stock';
                } else {
                    stockStatus = 'Normal';
                }
                return {
                    ...item,
                    stock_status: stockStatus
                };
            });
        }

        res.render('staff/kitchen_inventory_list', {
            title: 'Kitchen Inventory',
            user: req.session.user,
            items: itemsWithStatus, // Pass the array with added status
            updateStatus: update_status,
            addStatus: status,
            message: message,
            errorMessage: errorMessage
        });
    });
});

// GET /kitchen/inventory/add - Display form to add new item
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

// POST /kitchen/inventory/add - Handle submission for adding new item
router.post('/inventory/add', (req, res) => {
    const { item_name, category, quantity, unit, expiry_date, reorder_level } = req.body;

    // Validation
    if (!item_name || quantity === undefined || quantity === '' || !unit || parseFloat(quantity) < 0) {
        const message = encodeURIComponent('Invalid input. Name, non-negative quantity, and unit required.');
        return res.redirect(`/kitchen/inventory/add?status=error&message=${message}`);
    }

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
                 VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`;

    db.run(sql, [
        item_name,
        category || null,
        parseFloat(quantity),
        unit,
        expiry_date || null,
        reorderLevelValue
    ], function(err) {
        if (err) {
            console.error("Error adding inventory item:", err.message);
            const message = encodeURIComponent(err.message.includes('UNIQUE constraint') ? 'Item name already exists.' : 'Database error occurred.');
            return res.redirect(`/kitchen/inventory/add?status=error&message=${message}`);
        }
        console.log(`New inventory item added with ID ${this.lastID}`);
        const message = encodeURIComponent('Item added successfully!');
        res.redirect(`/kitchen/inventory?status=added_success&message=${message}`); // Redirect to inventory list
    });
});

// POST /kitchen/inventory/update/:itemId - Handle stock adjustments
router.post('/inventory/update/:itemId', (req, res) => {
    const itemId = req.params.itemId;
    const { change_amount } = req.body;

    // Validation
    if (change_amount === undefined || change_amount === '' || isNaN(parseFloat(change_amount))) {
        const message = encodeURIComponent('Invalid change amount provided. Please enter a number.');
        return res.redirect(`/kitchen/inventory?update_status=error&message=${message}&itemId=${itemId}`);
    }

    const amount = parseFloat(change_amount);

    // Optional: Check if the update would result in negative quantity.
    // This requires an initial SELECT, then the UPDATE, ideally in a transaction.
    // For simplicity here, we directly update, but rely on potential database constraints or later checks.
    const sql = `UPDATE inventory_items
                 SET quantity = quantity + ?, last_updated = CURRENT_TIMESTAMP
                 WHERE id = ?`;
    // Add 'AND quantity + ? >= 0' to prevent negative stock at DB level if desired:
    // SET quantity = quantity + ? WHERE id = ? AND quantity + ? >= 0

    db.run(sql, [amount, itemId], function(err) {
        if (err) {
            console.error(`Error updating inventory ${itemId}:`, err.message);
            const message = encodeURIComponent('Database error during update.');
            return res.redirect(`/kitchen/inventory?update_status=db_error&message=${message}&itemId=${itemId}`);
        }
        if (this.changes === 0) {
            // Could be item not found OR update resulted in negative stock (if using WHERE clause check)
            console.error(`Inventory item ${itemId} not found or update condition not met.`);
            const message = encodeURIComponent(`Item ID ${itemId} not found or update failed (e.g., negative stock prevented).`);
            return res.redirect(`/kitchen/inventory?update_status=not_found_or_failed&message=${message}`);
        }
        console.log(`Updated stock for inventory ID ${itemId} by ${amount}.`);
        const message = encodeURIComponent(`Stock for item ID ${itemId} updated successfully.`);
        res.redirect(`/kitchen/inventory?update_status=success&message=${message}`);
    });
});


// POST /kitchen/inventory/log-expired/:itemId - Handle logging expired items from dashboard
router.post('/inventory/log-expired/:itemId', (req, res) => { // Assumes ensureKitchenStaff is applied globally
    const itemId = req.params.itemId;
    // Get details passed from the hidden form inputs
    // Store the original value from the form
    const disposalMethodFromForm = req.body.disposal_method;
    const { quantity, unit, item_name } = req.body; // Other details
    const staffUserId = req.session.user.id;

    // --- Basic Validation ---
    // Validate the value received *from the form*
    if (!itemId || !disposalMethodFromForm || !['Recycled', 'Compost'].includes(disposalMethodFromForm) || quantity === undefined || parseFloat(quantity) <= 0 || !unit || !item_name) {
        console.error("Invalid input received for logging expired item:", { itemId, ...req.body });
        const message = encodeURIComponent('Invalid data received for logging expired item. Required fields missing or invalid.');
        return res.redirect(`/kitchen/dashboard?action_status=error&message=${message}`);
    }

    // --- Map to Database Allowed Values ---
    // Convert the validated form value to the required lowercase database value
    const dbDisposalMethod = ""; // Variable to hold the value for the database
    if (disposalMethodFromForm === 'Compost') {
        dbDisposalMethod = 'compost';
    } else if (disposalMethodFromForm === 'Recycled') {
        dbDisposalMethod = 'recycling';
    } else {
        // This case should not be reached due to the validation above,
        // but handle defensively just in case.
        console.error("Logic Error: Unexpected disposal method passed validation:", disposalMethodFromForm);
        const message = encodeURIComponent('An internal error occurred processing the disposal method.');
        return res.redirect(`/kitchen/dashboard?action_status=error&message=${message}`);
    }

    const currentQuantity = parseFloat(quantity); // The quantity being disposed of

    // --- Database Transaction ---
    db.serialize(() => {
        db.run("BEGIN TRANSACTION;");

        let logInsertSuccess = false;
        let inventoryUpdateSuccess = false;
        let finalRedirectUrl = `/kitchen/dashboard?action_status=error&message=${encodeURIComponent('An unexpected error occurred during the process.')}`;

        // Step 1: Log the waste item into kitchen_waste_logs
        const logSql = `INSERT INTO kitchen_waste_logs
                        (staff_user_id, waste_type, food_item, quantity, unit, reason, disposal_method, log_time)
                        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`;

        const wasteType = 'spoilage'; // Corrected from previous step
        const reasonForLogging = 'Expired';

        // Execute the insert statement using the mapped 'dbDisposalMethod'
        db.run(logSql, [staffUserId, wasteType, item_name, currentQuantity, unit, reasonForLogging, dbDisposalMethod /* Use mapped value */ ], function(err) {
            if (err) {
                console.error(`Transaction Error: Failed to log expired waste for item ID ${itemId}:`, err.message);
                db.run("ROLLBACK;");
                // Provide more specific error feedback if possible
                let errorDetail = err.message.includes('CHECK constraint failed') ? 'Invalid disposal method or waste type for DB.' : 'Database error logging waste.';
                finalRedirectUrl = `/kitchen/dashboard?action_status=db_error&message=${encodeURIComponent(errorDetail)}`;
                return res.redirect(finalRedirectUrl);
            }
            logInsertSuccess = true;
            console.log(`Expired waste logged with ID ${this.lastID} for inventory item ${itemId}`);

            // Step 2: Update the inventory item's quantity to 0
            const updateSql = `UPDATE inventory_items
                               SET quantity = 0, last_updated = CURRENT_TIMESTAMP
                               WHERE id = ? AND quantity > 0`;

            db.run(updateSql, [itemId], function(err) {
                if (err) {
                    console.error(`Transaction Error: Failed to update inventory quantity to 0 for item ID ${itemId}:`, err.message);
                    db.run("ROLLBACK;");
                    finalRedirectUrl = `/kitchen/dashboard?action_status=db_error&message=${encodeURIComponent('Database error updating inventory: ' + err.message)}`;
                    return res.redirect(finalRedirectUrl);
                }

                if (this.changes === 0) {
                    console.warn(`Transaction Warning: Inventory item ${itemId} not found or quantity already zero during expired item update. Waste was still logged.`);
                } else {
                    console.log(`Inventory quantity set to 0 for item ID ${itemId}`);
                }
                inventoryUpdateSuccess = true;

                // Step 3: Commit the transaction if both steps were successful
                if (logInsertSuccess && inventoryUpdateSuccess) {
                    db.run("COMMIT;", (commitErr) => {
                        if (commitErr) {
                            console.error(`Transaction Error: Failed to commit transaction for item ID ${itemId}:`, commitErr.message);
                            db.run("ROLLBACK;");
                            finalRedirectUrl = `/kitchen/dashboard?action_status=db_error&message=${encodeURIComponent('Database error finalizing action.')}`;
                        } else {
                            console.log(`Successfully logged expired item ${itemId} and updated inventory.`);
                            // Use the user-friendly value in the success message
                            const successMessage = encodeURIComponent(`Item '${item_name}' logged as ${disposalMethodFromForm} waste (Type: Spoilage).`);
                            finalRedirectUrl = `/kitchen/dashboard?action_status=success&message=${successMessage}`;
                        }
                        res.redirect(finalRedirectUrl);
                    });
                } else {
                    console.error(`Transaction Error: Reached end without full success for item ID ${itemId}, but errors not caught? Rolling back.`);
                    db.run("ROLLBACK;");
                    res.redirect(finalRedirectUrl);
                }
            }); // End inventory update callback
        }); // End log waste callback
    }); // End db.serialize
});

// --- Information & Resource Routes ---

// GET /kitchen/guides/segregation
router.get('/guides/segregation', (req, res) => {
    res.render('staff/kitchen_guide_segregation', {
        title: 'Waste Segregation Guide',
        user: req.session.user
    });
});

// GET /kitchen/guides/composting
router.get('/guides/composting', (req, res) => {
    res.render('staff/kitchen_guide_composting', {
        title: 'Composting Guide',
        user: req.session.user
    });
});

// GET /kitchen/facilities
router.get('/facilities', (req, res) => {
    const sql = `SELECT facility_name, address, facility_type, accepted_materials, contact_info, operating_hours
                 FROM recycling_facilities ORDER BY facility_name ASC`;
    db.all(sql, [], (err, facilities) => {
        let errorMessage = null;
        if (err) {
            console.error("Error fetching facilities:", err.message);
            errorMessage = "Could not load facility information.";
        }
        res.render('staff/kitchen_facilities_locator', {
            title: 'Nearby Recycling & Composting Facilities',
            user: req.session.user,
            facilities: facilities || [],
            errorMessage: errorMessage
        });
    });
});

// GET /kitchen/recipes/scraps
router.get('/recipes/scraps', (req, res) => {
    res.render('staff/kitchen_scrap_recipes', {
        title: 'Food Scrap Utilization Ideas',
        user: req.session.user
    });
});

// GET /kitchen/training
router.get('/training', (req, res) => {
    const sql = `SELECT title, description, content_url
                 FROM staff_training_materials
                 WHERE target_role = 'all' OR target_role = 'kitchen'`;
    db.all(sql, [], (err, materials) => {
        let errorMessage = null;
        if (err) {
            console.error("Error fetching training materials:", err.message);
            errorMessage = "Could not load training materials.";
        }
        res.render('staff/kitchen_training', {
            title: 'Kitchen Staff Training',
            user: req.session.user,
            materials: materials || [],
            errorMessage: errorMessage
        });
    });
});

// --- Export Router ---
module.exports = router;