'use strict';

const config = require('wild-config');
const log = require('npmlog');
const util = require('util');
const Joi = require('joi');
const db = require('./db');

const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;

const csrf = require('csurf');
const bodyParser = require('body-parser');

module.exports.parse = bodyParser.urlencoded({
    extended: false,
    limit: config.www.postsize
});

module.exports.csrf = csrf({
    cookie: true
});

module.exports.setup = app => {
    app.use(passport.initialize());
    app.use(passport.session());
};

module.exports.logout = (req, res) => {
    if (req.user) {
        req.flash('info', util.format('%s  logged out', req.user.address));
        req.logout();
    }
    res.redirect('/');
};

module.exports.login = (req, res, next) => {
    passport.authenticate('local', (err, user, info) => {
        if (err) {
            db.redis.incr('www:auth:fail', () => false);
            log.error('Passport', 'AUTHFAIL address=%s error=%s', req.body.address, err.message);
            req.flash('danger', err.message);
            return res.redirect('/login');
        }
        if (!user) {
            db.redis.incr('www:auth:fail', () => false);
            req.flash('danger', (info && info.message) || 'Failed to authenticate user');
            return res.redirect('/login');
        }
        req.logIn(user, err => {
            if (err) {
                db.redis.incr('www:auth:fail', () => false);
                log.error('Passport', 'AUTHFAIL address=%s error=%s', req.body.address, err.message);
                req.flash('danger', err.message);
                return res.redirect('/login');
            }

            if (req.body.remember) {
                // Cookie expires after 30 days
                req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
            } else {
                // Cookie expires at end of session
                req.session.cookie.expires = false;
            }

            db.redis.incr('www:auth:success', () => false);

            req.flash('success', util.format('Logged in as %s', user.address));
            return res.redirect('/');
        });
    })(req, res, next);
};

module.exports.checkLogin = (req, res, next) => {
    if (!req.user) {
        return res.redirect('/login');
    }
    next();
};

passport.use(
    new LocalStrategy(
        {
            usernameField: 'address',
            passReqToCallback: true
        },
        (req, address, password, done) => {
            const schema = Joi.object().keys({
                address: Joi.string().email().required(),
                password: Joi.string().max(256).required()
            });

            const result = Joi.validate(
                {
                    address,
                    password
                },
                schema,
                {
                    abortEarly: false,
                    convert: true
                }
            );

            if (result.error) {
                return done(new Error('Authentication failed'));
            }

            let meta = {
                protocol: 'web',
                ip: req.ip
            };

            db.userHandler.authenticate(address, password, 'master', meta, (err, authData) => {
                if (err) {
                    return done(err);
                }

                if (!authData) {
                    return done(new Error('Authentication failed'));
                }

                let user = {
                    id: authData.user,
                    username: authData.username,
                    address: authData.username + '@' + config.service.domain,
                    scope: authData.scope
                };

                req.session.regenerate(() => {
                    done(null, user);
                });
            });
        }
    )
);

passport.serializeUser((user, done) => {
    done(null, JSON.stringify(user));
});

passport.deserializeUser((user, done) => {
    let data = null;
    try {
        data = JSON.parse(user);
    } catch (E) {
        //ignore
    }
    done(null, data);
});
