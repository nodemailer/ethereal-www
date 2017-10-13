'use strict';

const config = require('wild-config');
const log = require('npmlog');
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const favicon = require('serve-favicon');
const logger = require('morgan');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const RedisStore = require('connect-redis')(session);
const flash = require('connect-flash');
const compression = require('compression');
const passport = require('./lib/passport');
const routesIndex = require('./routes/index');
const ObjectID = require('mongodb').ObjectID;
const db = require('./lib/db');
const hostname = require('os').hostname();

const app = express();

// setup extra hbs tags
require('./lib/hbs-helpers');

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'hbs');

// Handle proxies. Needed to resolve client IP
if (config.www.proxy) {
    app.set('trust proxy', config.www.proxy);
}

app.use((req, res, next) => {
    res.set('X-Served-By', hostname);
    next();
});

// Do not expose software used
app.disable('x-powered-by');

app.use(compression());
app.use(favicon(path.join(__dirname, 'public', 'favicon.ico')));

logger.token('username', req => (req.user ? req.user.username : false));

app.use(
    logger(config.www.log, {
        stream: {
            write: message => {
                message = (message || '').toString();
                if (message) {
                    log.info('HTTP', message.replace('\n', '').trim());
                }
            }
        }
    })
);

app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use(
    session({
        name: 'webmail',
        store: new RedisStore({
            client: db.redis.duplicate()
        }),
        secret: config.www.secret,
        saveUninitialized: false,
        resave: false,
        cookie: {
            secure: !!config.www.secure
        }
    })
);

app.use(flash());

app.use(
    bodyParser.urlencoded({
        extended: true,
        limit: config.www.postsize
    })
);

app.use(
    bodyParser.text({
        limit: config.www.postsize
    })
);

app.use(
    bodyParser.json({
        limit: config.www.postsize
    })
);

passport.setup(app);

app.use((req, res, next) => {
    // make sure flash messages are available
    res.locals.flash = req.flash.bind(req);

    if (req.user) {
        res.locals.user = req.user;
        req.user.id = new ObjectID(req.user.id);
    }

    res.locals.serviceName = config.name;
    res.locals.serviceDomain = config.service.domain;
    next();
});

// setup main routes
app.use('/', routesIndex);

// catch 404 and forward to error handler
app.use((req, res, next) => {
    let err = new Error('Not Found');
    err.status = 404;
    next(err);
});

// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
    app.use((err, req, res, next) => {
        if (!err) {
            return next();
        }
        res.status(err.status || 500);
        res.render('error', {
            message: err.message,
            error: err
        });
    });
}

// production error handler
// no stacktraces leaked to user
app.use((err, req, res, next) => {
    if (!err) {
        return next();
    }
    res.status(err.status || 500);
    res.render('error', {
        message: err.message,
        error: {}
    });
});

module.exports = app;
