// routes/maintenance.js

const express = require('express');
const db = require('../database/connection'); // Adjust path as needed
const router = express.Router();

// --- Middleware to ensure user is logged in as Maintenance (or Admin) ---
function ensureMaintenance(req, res, next) {
    if (req.session.user && (req.session.user.role === 'maintenance' || req.session.user.role === 'admin')) {
        return next();
    } else {
        // Redirect to login if not authorized
        res.redirect('/login');
    }
}

// Apply the middleware to all routes in this file
router.use(ensureMaintenance);

// --- GET /maintenance/dashboard ---
// Shows a dashboard for maintenance staff, maybe highlighting open faults.
router.get('/dashboard', (req, res) => {
    // Example: Fetch open fault reports
    const openFaultsSql = `SELECT log_id, log_time, description, room_id, equipment_id, status
                           FROM maintenance_logs
                           WHERE log_type = 'fault_report' AND status != 'closed'
                           ORDER BY log_time DESC`;

    db.all(openFaultsSql, [], (err, openFaults) => {
        if (err) {
            console.error("Error fetching open faults for dashboard:", err.message);
            // Render dashboard even if faults query fails? Or redirect?
            openFaults = []; // Default to empty array on error
        }
        res.render('staff/maintenance_dashboard', { // Assumes views/staff/maintenance_dashboard.ejs
            title: 'Maintenance Dashboard',
            user: req.session.user,
            openFaults: openFaults
        });
    });
});

// --- GET /maintenance/log ---
// Shows a general form for logging various maintenance tasks
router.get('/log', (req, res) => {
    // Fetch rooms list for dropdown selection (optional)
    db.all(`SELECT id, room_number FROM rooms ORDER BY room_number ASC`, [], (err, rooms) => {
         if (err) {
            console.error("Error fetching rooms for log form:", err.message);
            rooms = []; // Proceed without rooms list if query fails
        }
        res.render('staff/maintenance_log_form', { // Assumes views/staff/maintenance_log_form.ejs
            title: 'Log Maintenance Task',
            user: req.session.user,
            rooms: rooms // Pass rooms for selection
        });
    });
});

// --- POST /maintenance/log ---
// Handles submission of the maintenance log form
router.post('/log', (req, res) => {
    const staffUserId = req.session.user.id;
    const { log_type, description, room_id, equipment_id, energy_reading, status } = req.body;

    // --- Basic Validation ---
    const allowedLogTypes = ['energy_reading', 'scheduled_check', 'fault_report', 'repair'];
    if (!log_type || !allowedLogTypes.includes(log_type) || !description) {
         console.error("Invalid input for maintenance log:", req.body);
         // Redirect back to form with error
         return res.redirect('/maintenance/log?log_status=error&message=InvalidInput');
    }
    // Additional validation based on log_type (e.g., energy_reading required if type is energy_reading)
     if (log_type === 'energy_reading' && (energy_reading === undefined || isNaN(parseFloat(energy_reading)))) {
         return res.redirect('/maintenance/log?log_status=error&message=InvalidEnergyReading');
     }

    const sql = `INSERT INTO maintenance_logs
                 (staff_user_id, log_type, description, room_id, equipment_id, energy_reading, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`;

    // Determine default status based on log type if not provided
    let currentStatus = status;
    if (!currentStatus && (log_type === 'fault_report' || log_type === 'repair')) {
        currentStatus = 'open'; // Default status for faults/repairs
    }

    // Use null for optional fields if empty string is provided
    const roomIdVal = room_id || null;
    const equipmentIdVal = equipment_id || null;
    const energyReadingVal = log_type === 'energy_reading' ? parseFloat(energy_reading) : null;


    db.run(sql, [staffUserId, log_type, description, roomIdVal, equipmentIdVal, energyReadingVal, currentStatus], function(err) {
        if (err) {
            console.error("Error inserting maintenance log:", err.message);
            res.redirect('/maintenance/dashboard?log_status=error&message=InsertFailed');
        } else {
            console.log(`New maintenance log created with ID ${this.lastID} by user ${staffUserId}`);
            res.redirect('/maintenance/dashboard?log_status=success'); // Redirect to dashboard on success
        }
    });
});

// --- GET /maintenance/faults ---
// Displays a list of open or all fault reports
router.get('/faults', (req, res) => {
    // Example: Fetch all fault reports (open and closed) joining with room/user if needed
     const sql = `SELECT
                    ml.log_id, ml.log_time, ml.description, ml.status, ml.room_id, ml.equipment_id,
                    r.room_number, u.username as reported_by
                 FROM maintenance_logs ml
                 LEFT JOIN rooms r ON ml.room_id = r.id
                 JOIN users u ON ml.staff_user_id = u.id
                 WHERE ml.log_type = 'fault_report' -- Only show fault reports
                 ORDER BY ml.status ASC, ml.log_time DESC`; // Show open ones first, then by time

    db.all(sql, [], (err, faults) => {
         if (err) {
            console.error("Error fetching fault list:", err.message);
            return res.redirect('/maintenance/dashboard');
         }
         res.render('staff/maintenance_faults_list', { // Assumes views/staff/maintenance_faults_list.ejs
            title: 'Fault Reports',
            user: req.session.user,
            faults: faults
         });
    });
});

// --- POST /maintenance/faults/update/:logId ---
// Updates the status of a specific fault report
router.post('/faults/update/:logId', (req, res) => {
    const logId = req.params.logId;
    const { new_status } = req.body; // Expecting the new status from the form

    const allowedStatuses = ['open', 'in_progress', 'resolved', 'closed'];
    if (!new_status || !allowedStatuses.includes(new_status)) {
        console.error("Invalid status update attempt:", new_status);
        return res.redirect('/maintenance/faults?update_status=error&message=InvalidStatus');
    }

    const sql = `UPDATE maintenance_logs
                 SET status = ?
                 WHERE log_id = ? AND log_type = 'fault_report'`; // Ensure we only update fault reports

    db.run(sql, [new_status, logId], function(err) {
        if (err) {
            console.error(`Error updating status for fault log ${logId}:`, err.message);
            res.redirect('/maintenance/faults?update_status=db_error');
        } else if (this.changes === 0) {
             console.error(`Fault log ${logId} not found or not a fault report.`);
             res.redirect('/maintenance/faults?update_status=not_found');
        } else {
            console.log(`Status updated for fault log ${logId} to ${new_status}`);
            res.redirect('/maintenance/faults?update_status=success');
        }
    });
});

// --- GET /maintenance/equipment ---
// Displays a list of all registered equipment
router.get('/equipment', (req, res) => {
    const sql = `SELECT eq.id, eq.name, eq.asset_tag, eq.location_description, r.room_number, eq.last_service_date, eq.service_interval_days
                 FROM equipment eq
                 LEFT JOIN rooms r ON eq.location_room_id = r.id
                 ORDER BY eq.name ASC`;

    db.all(sql, [], (err, equipmentList) => {
        if (err) {
            console.error("Error fetching equipment list:", err.message);
            return res.redirect('/maintenance/dashboard'); // Redirect on error
        }
        res.render('staff/maintenance_equipment_list', { // Assumes views/staff/maintenance_equipment_list.ejs
            title: 'Hotel Equipment List',
            user: req.session.user,
            equipmentList: equipmentList
        });
    });
});

// --- GET /maintenance/equipment/add ---
// Displays the form to add a new piece of equipment
router.get('/equipment/add', (req, res) => {
    // Fetch rooms for location dropdown
    db.all(`SELECT id, room_number FROM rooms ORDER BY room_number ASC`, [], (err, rooms) => {
        if (err) {
            console.error("Error fetching rooms for add equipment form:", err.message);
            rooms = []; // Proceed without rooms list if query fails
        }
        res.render('staff/maintenance_equipment_form', { // Assumes views/staff/maintenance_equipment_form.ejs
            title: 'Add New Equipment',
            user: req.session.user,
            equipment: null, // Pass null when adding (no existing data)
            rooms: rooms,
            form_action: '/maintenance/equipment/add' // Specify form submission URL
        });
    });
});

// --- GET /maintenance/equipment/edit/:equipmentId ---
// Displays the form to edit an existing piece of equipment
router.get('/equipment/edit/:equipmentId', (req, res) => {
    const equipmentId = req.params.equipmentId;

    const equipmentSql = `SELECT * FROM equipment WHERE id = ?`;
    const roomsSql = `SELECT id, room_number FROM rooms ORDER BY room_number ASC`;

    Promise.all([
        new Promise((resolve, reject) => {
            db.get(equipmentSql, [equipmentId], (err, equipment) => {
                if (err) return reject(`Error fetching equipment for edit: ${err.message}`);
                if (!equipment) return reject('Equipment not found');
                resolve(equipment);
            });
        }),
        new Promise((resolve, reject) => {
            db.all(roomsSql, [], (err, rooms) => {
                 if (err) return reject(`Error fetching rooms for edit form: ${err.message}`);
                 resolve(rooms);
            });
        })
    ])
    .then(([equipment, rooms]) => {
         res.render('staff/maintenance_equipment_form', { // Reuse the same form view
             title: `Edit Equipment: ${equipment.name}`,
             user: req.session.user,
             equipment: equipment, // Pass existing equipment data to pre-fill form
             rooms: rooms,
             form_action: `/maintenance/equipment/edit/${equipmentId}` // Specify form submission URL
         });
    })
    .catch(error => {
        console.error("Error loading equipment edit page:", error);
        res.redirect('/maintenance/equipment'); // Redirect to list on error
    });
});

// --- GET /maintenance/equipment/:equipmentId ---
// Displays details for a specific piece of equipment and its maintenance history
router.get('/equipment/:equipmentId', (req, res) => {
    const equipmentId = req.params.equipmentId;
    console.log('Attempting to fetch details for equipment ID:', equipmentId); // <-- ADD THIS LINE

    const equipmentSql = `SELECT eq.*, r.room_number
                          FROM equipment eq
                          LEFT JOIN rooms r ON eq.location_room_id = r.id
                          WHERE eq.id = ?`;
    // Fetch maintenance logs specifically related to this equipment (using equipment_id)
    const logsSql = `SELECT ml.log_id, ml.log_time, ml.log_type, ml.description, ml.status, u.username as staff_username
                     FROM maintenance_logs ml
                     JOIN users u ON ml.staff_user_id = u.id
                     WHERE ml.equipment_id = ? -- Assuming equipment_id in logs matches equipment.id or asset_tag
                     ORDER BY ml.log_time DESC`; // Adjust matching logic if needed (e.g., use asset_tag)

    Promise.all([
        new Promise((resolve, reject) => {
            db.get(equipmentSql, [equipmentId], (err, equipment) => {
                if (err) return reject(`Error fetching equipment details: ${err.message}`);
                if (!equipment) return reject('Equipment not found');
                resolve(equipment);
            });
        }),
        new Promise((resolve, reject) => {
             // Using equipment.id here - adjust if logs store asset_tag instead
            db.all(logsSql, [equipmentId], (err, logs) => {
                if (err) return reject(`Error fetching maintenance logs for equipment: ${err.message}`);
                resolve(logs);
            });
        })
    ])
    .then(([equipment, maintenanceHistory]) => {
         res.render('staff/maintenance_equipment_detail', { // Assumes views/staff/maintenance_equipment_detail.ejs
             title: `Details for ${equipment.name}`,
             user: req.session.user,
             equipment: equipment,
             maintenanceHistory: maintenanceHistory
         });
    })
    .catch(error => {
         console.error("Error loading equipment detail page:", error);
         // Redirect or show error page
         res.redirect('/maintenance/equipment');
    });
});

// --- POST /maintenance/equipment/add ---
// Handles the submission for adding new equipment
router.post('/equipment/add', (req, res) => {
    const { name, asset_tag, location_description, location_room_id, install_date, last_service_date, service_interval_days, notes } = req.body;

    // --- Basic Validation ---
    if (!name) {
        // Add more robust validation as needed
        console.error("Validation failed: Equipment name is required.");
        // Re-render form with error (need to fetch rooms again or pass error differently)
        return res.redirect('/maintenance/equipment/add?status=error&message=NameRequired');
    }

    const sql = `INSERT INTO equipment
                 (name, asset_tag, location_description, location_room_id, install_date, last_service_date, service_interval_days, notes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

    db.run(sql, [
        name,
        asset_tag || null,
        location_description || null,
        location_room_id || null, // Use null if no room selected/provided
        install_date || null,
        last_service_date || null,
        service_interval_days || null,
        notes || null
    ], function(err) {
        if (err) {
            console.error("Error adding new equipment:", err.message);
             // Handle specific errors like UNIQUE constraint violation (asset_tag)
            if (err.message.includes('UNIQUE constraint failed: equipment.asset_tag')) {
                 return res.redirect('/maintenance/equipment/add?status=error&message=AssetTagExists');
            }
            return res.redirect('/maintenance/equipment/add?status=error&message=InsertFailed');
        }
        console.log(`New equipment added with ID ${this.lastID}`);
        res.redirect('/maintenance/equipment?status=added_success'); // Redirect to list view
    });
});

// --- POST /maintenance/equipment/edit/:equipmentId ---
// Handles the submission for editing existing equipment
router.post('/equipment/edit/:equipmentId', (req, res) => {
    const equipmentId = req.params.equipmentId;
    const { name, asset_tag, location_description, location_room_id, install_date, last_service_date, service_interval_days, notes } = req.body;

    // --- Basic Validation ---
    if (!name) {
         console.error("Validation failed: Equipment name is required.");
         return res.redirect(`/maintenance/equipment/edit/${equipmentId}?status=error&message=NameRequired`);
    }

    const sql = `UPDATE equipment SET
                    name = ?,
                    asset_tag = ?,
                    location_description = ?,
                    location_room_id = ?,
                    install_date = ?,
                    last_service_date = ?,
                    service_interval_days = ?,
                    notes = ?
                 WHERE id = ?`;

    db.run(sql, [
        name,
        asset_tag || null,
        location_description || null,
        location_room_id || null,
        install_date || null,
        last_service_date || null,
        service_interval_days || null,
        notes || null,
        equipmentId // The ID of the equipment to update
    ], function(err) {
         if (err) {
            console.error(`Error updating equipment ${equipmentId}:`, err.message);
             // Handle specific errors like UNIQUE constraint violation (asset_tag)
            if (err.message.includes('UNIQUE constraint failed: equipment.asset_tag')) {
                 return res.redirect(`/maintenance/equipment/edit/${equipmentId}?status=error&message=AssetTagExists`);
            }
            return res.redirect(`/maintenance/equipment/edit/${equipmentId}?status=error&message=UpdateFailed`);
         }
         if (this.changes === 0) {
             console.error(`Equipment ${equipmentId} not found for update.`);
             return res.redirect('/maintenance/equipment?status=error&message=NotFound');
         }
         console.log(`Equipment ${equipmentId} updated successfully.`);
         res.redirect(`/maintenance/equipment/${equipmentId}?status=updated_success`); // Redirect to detail view
    });
});

// --- GET /maintenance/schedule ---
// Displays past and potentially upcoming scheduled maintenance checks
router.get('/schedule', (req, res) => {
    // Fetch logs marked as 'scheduled_check'
    // A real scheduling system would likely involve due dates based on equipment.last_service_date + service_interval_days
    // This is a simplified view showing historical checks logged.
    const sql = `SELECT ml.log_id, ml.log_time, ml.description, ml.equipment_id, eq.name as equipment_name, u.username as performed_by
                 FROM maintenance_logs ml
                 LEFT JOIN equipment eq ON ml.equipment_id = eq.id -- Adjust join if equipment_id refers to asset_tag
                 JOIN users u ON ml.staff_user_id = u.id
                 WHERE ml.log_type = 'scheduled_check'
                 ORDER BY ml.log_time DESC`;

    db.all(sql, [], (err, scheduleLogs) => {
        if (err) {
            console.error("Error fetching maintenance schedule logs:", err.message);
            return res.redirect('/maintenance/dashboard');
        }
        res.render('staff/maintenance_schedule', { // Assumes views/staff/maintenance_schedule.ejs
            title: 'Maintenance Schedule Log',
            user: req.session.user,
            scheduleLogs: scheduleLogs
        });
    });
});

module.exports = router;