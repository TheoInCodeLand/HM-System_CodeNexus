const express = require('express');
const router = express.Router();
const db = require('../database/connection');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

router.get('/', (req, res) => {
    const user = req.session.user || null;

    res.render('home', { 
        title: 'Tfokomala Hotel Sustainability Hub',
        user: user,
        message: req.session.message || null,
        error: req.session.error || null
    
    });
});

router.get('/login', (req, res) => {
    if (req.session.user) {
        return res.redirect('/');
    }
    res.render('auth/login', { title: 'Sign-in Page' });
});

router.get('/register', (req, res) => {
    if (req.session.user) {
        return res.redirect('/');
    }
    res.render('auth/register', { title: 'Sign-up Page' });
});


module.exports = router;