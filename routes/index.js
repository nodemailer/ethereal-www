'use strict';

const generatePassword = require('generate-password');
const MongoPaging = require('mongo-cursor-pagination');
const config = require('wild-config');
const express = require('express');
const EtherealId = require('ethereal-id');
const router = new express.Router();
const passport = require('../lib/passport');
const mdrender = require('../lib/mdrender.js');
const db = require('../lib/db');
const libqp = require('libqp');
const Joi = require('joi');
const he = require('he');
const libbase64 = require('libbase64');
const libmime = require('libmime');
const tools = require('wildduck/lib/tools');
const messageTools = require('../lib/message-tools');
const addressparser = require('addressparser');
const humanize = require('humanize');
const base32 = require('hi-base32');
const crypto = require('crypto');
const ObjectID = require('mongodb').ObjectID;
const etherealId = new EtherealId({
    secret: config.service.msgidSecret,
    hash: config.service.msgidHash
});

router.use(passport.csrf);

/* GET home page. */
router.get('/', (req, res) => {
    db.redis
        .multi()
        .get('api:create')
        .get('www:create')
        .get('msa:count:accept')
        .hgetall('msa:count:accept:daily')
        .exec((err, results) => {
            if (err) {
                // ignore
            }
            results = results || [];

            let stats = (results[3] && results[3][1]) || {};
            let statSeries = Object.keys(stats || {})
                .map(key => ({ x: key, y: Number(stats[key]) }))
                .sort((a, b) => a.x.localeCompare(b.x))
                .slice(-15);

            res.render('index', {
                activeHome: true,
                accounts: humanize.numberFormat((Number(results[0] && results[0][1]) || 0) + (Number(results[1] && results[1][1]) || 0), 0, ',', ' '),
                messages: humanize.numberFormat(Number(results[2] && results[2][1]) || 0, 0, ',', ' '),
                page: mdrender('index', { title: 'test' }),
                statSeries: JSON.stringify(statSeries),
                csrfToken: req.csrfToken()
            });
        });
});

router.get('/faq', (req, res) => {
    res.render('docs', {
        activeFaq: true,
        title: 'FAQ',
        page: mdrender('faq')
    });
});

router.get('/help', (req, res) => {
    res.render('help', {
        activeHelp: true,
        smtp: config.smtp,
        imap: config.imap,
        pop3: config.pop3
    });
});

router.get('/login', (req, res) => {
    res.render('login', {
        activeLogin: true,
        csrfToken: req.csrfToken()
    });
});

router.post('/login', passport.parse, (req, res, next) => passport.login(req, res, next));

router.get('/logout', (req, res) => {
    req.session.require2fa = false;
    req.flash(); // clear pending messages
    passport.logout(req, res);
});

router.get('/message/:id/source', (req, res, next) => {
    let data = etherealId.validate(req.params.id);
    if (!data) {
        let err = new Error('Invalid or unknown message identifier');
        err.status = 404;
        return next(err);
    }

    data.warnPublic = true;
    renderSource(req, res, next, data);
});

router.get('/messages/:mailbox/:message/source', checkLogin, (req, res, next) => {
    const schema = Joi.object().keys({
        mailbox: Joi.string()
            .hex()
            .lowercase()
            .length(24)
            .required(),
        message: Joi.number()
            .min(1)
            .required()
    });

    const result = Joi.validate(req.params, schema, {
        abortEarly: false,
        convert: true,
        allowUnknown: true
    });

    if (result.error) {
        let err = new Error(result.error.message);
        err.status = 500;
        return next(err);
    }

    db.database.collection('mailboxes').findOne(
        {
            _id: new ObjectID(result.value.mailbox)
        },
        {
            fields: {
                _id: true,
                user: true
            }
        },
        (err, mailboxData) => {
            if (err) {
                err.message = 'MongoDB Error: ' + err.message;
                err.status = 500;
                return next(err);
            }
            if (!mailboxData) {
                let err = new Error('This mailbox does not exist');
                err.status = 404;
                return next(err);
            }

            if (mailboxData.user.toString() !== req.user.id.toString()) {
                let err = new Error('Not authorized to see requested message');
                err.status = 403;
                return next(err);
            }

            renderSource(req, res, next, {
                mailboxId: mailboxData._id,
                uid: result.value.message,
                usePrivateUrl: true
            });
        }
    );
});

router.get('/messages/:mailbox/:message/message.eml', checkLogin, (req, res, next) => {
    const schema = Joi.object().keys({
        mailbox: Joi.string()
            .hex()
            .lowercase()
            .length(24)
            .required(),
        message: Joi.number()
            .min(1)
            .required()
    });

    const result = Joi.validate(req.params, schema, {
        abortEarly: false,
        convert: true,
        allowUnknown: true
    });

    if (result.error) {
        let err = new Error(result.error.message);
        err.status = 500;
        return next(err);
    }

    db.database.collection('mailboxes').findOne(
        {
            _id: new ObjectID(result.value.mailbox)
        },
        {
            fields: {
                _id: true,
                user: true
            }
        },
        (err, mailboxData) => {
            if (err) {
                err.message = 'MongoDB Error: ' + err.message;
                err.status = 500;
                return next(err);
            }
            if (!mailboxData) {
                let err = new Error('This mailbox does not exist');
                err.status = 404;
                return next(err);
            }

            if (mailboxData.user.toString() !== req.user.id.toString()) {
                let err = new Error('Not authorized to see requested message');
                err.status = 403;
                return next(err);
            }

            let mailbox = mailboxData._id;
            let uid = result.value.message;

            db.database.collection('messages').findOne(
                {
                    mailbox,
                    uid
                },
                {
                    fields: {
                        _id: true,
                        user: true,
                        mimeTree: true
                    }
                },
                (err, messageData) => {
                    if (err) {
                        return next(err);
                    }

                    if (!messageData) {
                        let err = new Error('This message does not exist');
                        err.status = 404;
                        return next(err);
                    }

                    let raw = db.messageHandler.indexer.rebuild(messageData.mimeTree);
                    if (!raw || raw.type !== 'stream' || !raw.value) {
                        let err = new Error('This message does not exist');
                        err.status = 404;
                        return next(err);
                    }

                    res.setHeader('Content-Type', 'message/rfc822');
                    raw.value.pipe(res);

                    raw.value.once('error', err => {
                        err.message = 'Database error. ' + err.message;
                        err.status = 500;
                        return next(err);
                    });
                }
            );
        }
    );
});

router.get('/message/:id/message.eml', (req, res, next) => {
    let data = etherealId.validate(req.params.id);
    if (!data) {
        let err = new Error('Invalid or unknown message identifier');
        err.status = 404;
        return next(err);
    }

    let mailbox = new ObjectID(data.mailboxId);
    let message = new ObjectID(data.messageId);
    let uid = data.uid;

    db.database.collection('messages').findOne(
        {
            _id: message,
            mailbox,
            uid
        },
        {
            fields: {
                _id: true,
                user: true,
                mimeTree: true
            }
        },
        (err, messageData) => {
            if (err) {
                return next(err);
            }

            if (!messageData) {
                let err = new Error('This message does not exist');
                err.status = 404;
                return next(err);
            }

            let raw = db.messageHandler.indexer.rebuild(messageData.mimeTree);
            if (!raw || raw.type !== 'stream' || !raw.value) {
                let err = new Error('This message does not exist');
                err.status = 404;
                return next(err);
            }

            res.setHeader('Content-Type', 'message/rfc822');
            raw.value.pipe(res);

            raw.value.once('error', err => {
                err.message = 'Database error. ' + err.message;
                err.status = 500;
                return next(err);
            });
        }
    );
});

router.get('/message/:id', (req, res, next) => {
    let data = etherealId.validate(req.params.id);
    if (!data) {
        let err = new Error('Invalid or unknown message identifier');
        err.status = 404;
        db.redis.incr('www:404:public', () => false);
        return next(err);
    }

    db.redis.incr('www:view:public', () => false);

    data.warnPublic = true;
    renderMessage(req, res, next, data);
});

router.get('/messages/:mailbox/:message', checkLogin, (req, res, next) => {
    const schema = Joi.object().keys({
        mailbox: Joi.string()
            .hex()
            .lowercase()
            .length(24)
            .required(),
        message: Joi.number()
            .min(1)
            .required()
    });

    const result = Joi.validate(req.params, schema, {
        abortEarly: false,
        convert: true,
        allowUnknown: true
    });

    if (result.error) {
        let err = new Error(result.error.message);
        err.status = 500;
        return next(err);
    }

    db.database.collection('mailboxes').findOne(
        {
            _id: new ObjectID(result.value.mailbox)
        },
        {
            fields: {
                _id: true,
                user: true
            }
        },
        (err, mailboxData) => {
            if (err) {
                err.message = 'MongoDB Error: ' + err.message;
                err.status = 500;
                return next(err);
            }
            if (!mailboxData) {
                let err = new Error('This mailbox does not exist');
                err.status = 404;
                return next(err);
            }

            if (mailboxData.user.toString() !== req.user.id.toString()) {
                let err = new Error('Not authorized to see requested message');
                err.status = 403;
                return next(err);
            }

            db.redis.incr('www:view:private', () => false);

            renderMessage(req, res, next, {
                mailboxId: mailboxData._id,
                uid: result.value.message,
                usePrivateUrl: true
            });
        }
    );
});

router.get('/attachment/:id/:aid', (req, res, next) => {
    let data = etherealId.validate(req.params.id);
    if (!data) {
        let err = new Error('Invalid or unknown message identifier');
        err.status = 404;
        return next(err);
    }

    renderAttachment(req, res, next, data);
});

router.get('/messages/:mailbox/:message/attachment/:aid', checkLogin, (req, res, next) => {
    const schema = Joi.object().keys({
        mailbox: Joi.string()
            .hex()
            .lowercase()
            .length(24)
            .required(),
        message: Joi.number()
            .min(1)
            .required()
    });

    const result = Joi.validate(req.params, schema, {
        abortEarly: false,
        convert: true,
        allowUnknown: true
    });

    if (result.error) {
        let err = new Error(result.error.message);
        err.status = 500;
        return next(err);
    }

    db.database.collection('mailboxes').findOne(
        {
            _id: new ObjectID(result.value.mailbox)
        },
        {
            fields: {
                _id: true,
                user: true
            }
        },
        (err, mailboxData) => {
            if (err) {
                err.message = 'MongoDB Error: ' + err.message;
                err.status = 500;
                return next(err);
            }
            if (!mailboxData) {
                let err = new Error('This mailbox does not exist');
                err.status = 404;
                return next(err);
            }

            if (mailboxData.user.toString() !== req.user.id.toString()) {
                let err = new Error('Not authorized to see requested message');
                err.status = 403;
                return next(err);
            }

            renderAttachment(req, res, next, {
                mailboxId: mailboxData._id,
                uid: result.value.message
            });
        }
    );
});

router.get('/messages', checkLogin, (req, res, next) => {
    const schema = Joi.object().keys({
        limit: Joi.number()
            .empty('')
            .default(20)
            .min(1)
            .max(250),
        order: Joi.any()
            .empty('')
            .allow(['asc', 'desc'])
            .default('desc'),
        next: Joi.string()
            .empty('')
            .alphanum()
            .max(100),
        previous: Joi.string()
            .empty('')
            .alphanum()
            .max(100),
        page: Joi.number()
            .empty('')
            .default(1)
    });

    const result = Joi.validate(req.query, schema, {
        abortEarly: false,
        convert: true,
        allowUnknown: true
    });

    if (result.error) {
        let err = new Error(result.error.message);
        err.status = 500;
        return next(err);
    }

    let user = req.user.id;
    let limit = result.value.limit;
    let page = result.value.page;
    let pageNext = result.value.next;
    let pagePrevious = result.value.previous;
    let sortAscending = result.value.order === 'asc';

    db.database.collection('mailboxes').findOne(
        {
            user,
            path: 'INBOX'
        },
        {
            fields: {
                _id: true,
                path: true,
                specialUse: true,
                uidNext: true
            }
        },
        (err, mailboxData) => {
            if (err) {
                err.message = 'MongoDB Error: ' + err.message;
                err.status = 500;
                return next(err);
            }
            if (!mailboxData) {
                let err = new Error('This mailbox does not exist');
                err.status = 404;
                return next(err);
            }

            let filter = {
                mailbox: mailboxData._id,
                // uid is part of the sharding key so we need it somehow represented in the query
                uid: {
                    $gt: 0,
                    $lt: mailboxData.uidNext
                }
            };

            getFilteredMessageCount(db, filter, (err, total) => {
                if (err) {
                    err.status = 500;
                    return next(err);
                }

                let opts = {
                    limit,
                    query: filter,
                    fields: {
                        _id: true,
                        uid: true,
                        'meta.from': true,
                        hdate: true,
                        flags: true,
                        subject: true,
                        'mimeTree.parsedHeader.from': true,
                        'mimeTree.parsedHeader.to': true,
                        'mimeTree.parsedHeader.cc': true,
                        'mimeTree.parsedHeader.sender': true,
                        'mimeTree.parsedHeader.content-type': true,
                        ha: true,
                        intro: true,
                        unseen: true,
                        undeleted: true,
                        flagged: true,
                        draft: true,
                        thread: true
                    },
                    paginatedField: 'uid',
                    sortAscending
                };

                if (pageNext) {
                    opts.next = pageNext;
                } else if (pagePrevious) {
                    opts.previous = pagePrevious;
                }

                MongoPaging.find(db.database.collection('messages'), opts, (err, result) => {
                    if (err) {
                        let err = new Error(result.error.message);
                        err.status = 500;
                        return next(err);
                    }

                    if (!result.hasPrevious) {
                        page = 1;
                    }

                    let prevUrl = result.hasPrevious
                        ? renderRoute('messages', { previous: result.previous, limit, order: sortAscending ? 'asc' : 'desc', page: Math.max(page - 1, 1) })
                        : false;
                    let nextUrl = result.hasNext
                        ? renderRoute('messages', { next: result.next, limit, order: sortAscending ? 'asc' : 'desc', page: page + 1 })
                        : false;

                    let response = {
                        activeMessages: true,
                        total,
                        page,
                        nextPage: page + 1,
                        previousPage: Math.max(page - 1, 1),
                        previous: prevUrl,
                        previousCursor: result.hasPrevious ? result.previous : false,
                        next: nextUrl,
                        nextCursor: result.hasNext ? result.next : false,
                        specialUse: mailboxData.specialUse,
                        results: (result.results || []).map(messageData => {
                            let parsedHeader = (messageData.mimeTree && messageData.mimeTree.parsedHeader) || {};
                            let from = parsedHeader.from ||
                                parsedHeader.sender || [
                                    {
                                        name: '',
                                        address: (messageData.meta && messageData.meta.from) || ''
                                    }
                                ];
                            tools.decodeAddresses(from);

                            let to = parsedHeader.to || parsedHeader.cc || [].concat(messageData.meta.to || []).map(to => ({ name: '', address: to }));
                            tools.decodeAddresses(to);

                            let response = {
                                id: messageData.uid,
                                publicId: etherealId.get(mailboxData._id.toString(), messageData._id.toString(), messageData.uid),
                                mailbox: mailboxData._id,
                                thread: messageData.thread,
                                from,
                                to,
                                subject: messageData.subject,
                                date: messageData.hdate.toISOString(),
                                intro: messageData.intro,
                                attachments: !!messageData.ha,
                                seen: !messageData.unseen,
                                deleted: !messageData.undeleted,
                                flagged: messageData.flagged,
                                draft: messageData.draft,
                                fromHtml: messageTools.getAddressesHTML(from),
                                toHtml: messageTools.getAddressesHTML(to),
                                flags: messageData.flags,
                                outbound: messageData.flags.includes('$msa$delivery')
                            };
                            let parsedContentType = parsedHeader['content-type'];
                            if (parsedContentType) {
                                response.contentType = {
                                    value: parsedContentType.value
                                };
                                if (parsedContentType.hasParams) {
                                    response.contentType.params = parsedContentType.params;
                                }

                                if (parsedContentType.subtype === 'encrypted') {
                                    response.encrypted = true;
                                }
                            }

                            return response;
                        })
                    };

                    res.render('messages', response);
                });
            });
        }
    );
});

router.post('/create', (req, res, next) => {
    let username = getId();
    let userData = {
        username,
        password: generatePassword.generate({
            length: 18,
            numbers: true,
            symbols: false,
            excludeSimilarCharacters: true
        }),
        address: username + '@' + config.service.domain,
        recipients: 500,
        forwards: 500,
        quota: 100 * 1024 * 1024,
        retention: 21600000,
        ip: req.ip
    };

    db.userHandler.create(userData, (err, id) => {
        if (err) {
            err.status = 500;
            return next(err);
        }

        req.flash('success', 'Account created for ' + userData.address);

        db.redis.incr('www:create', () => false);

        let escapeCsv = value => JSON.stringify(value);
        let csv = [
            ['Service', 'Username', 'Password', 'Hostname', 'Port', 'Security'],
            ['SMTP', userData.address, userData.password, config.smtp.host, config.smtp.port, 'STARTTLS'],
            ['IMAP', userData.address, userData.password, config.imap.host, config.imap.port, 'TLS'],
            ['POP3', userData.address, userData.password, config.pop3.host, config.pop3.port, 'TLS']
        ]
            .map(line => line.map(value => escapeCsv(value)).join(','))
            .join('\n');

        res.render('create', {
            activeCreate: true,
            id,
            userData,
            encodedUser: userData.address,
            encodedPass: userData.password.replace(/'/g, '\\\''),
            smtp: config.smtp,
            imap: config.imap,
            pop3: config.pop3,
            csvData: Buffer.from(csv).toString('base64')
        });
    });
});

module.exports = router;

function getMessage(id, mailbox, message, uid, usePrivateUrl, callback) {
    let query = {};
    if (message) {
        query._id = message;
    }
    query.mailbox = mailbox;
    query.uid = uid;

    db.database.collection('messages').findOne(
        query,
        {
            fields: {
                _id: true,
                uid: true,
                user: true,
                mailbox: true,
                thread: true,
                meta: true,
                hdate: true,
                'mimeTree.parsedHeader': true,
                msgid: true,
                exp: true,
                rdate: true,
                ha: true,
                unseen: true,
                undeleted: true,
                flagged: true,
                draft: true,
                attachments: true,
                html: true,
                text: true,
                textFooter: true
            }
        },
        (err, messageData) => {
            if (err) {
                err.message = 'Database error.' + err.message;
                err.status = 500;
                return callback(err);
            }

            if (!messageData) {
                let err = new Error('This message does not exist');
                err.status = 404;
                return callback(err);
            }

            let publicId = etherealId.get(messageData.mailbox.toString(), messageData._id.toString(), messageData.uid);
            let messageUrl = usePrivateUrl ? '/messages/' + mailbox + '/' + uid : '/message/' + publicId;
            let attachmentUrl = usePrivateUrl ? '/messages/' + mailbox + '/' + uid + '/attachment' : '/attachment/' + publicId;

            let parsedHeader = (messageData.mimeTree && messageData.mimeTree.parsedHeader) || {};

            let subject = parsedHeader.subject;
            try {
                subject = libmime.decodeWords(subject);
            } catch (E) {
                //
            }

            let from = parsedHeader.from;
            if (from) {
                tools.decodeAddresses(from);
            }

            let sender = parsedHeader.sender;
            if (sender) {
                tools.decodeAddresses(sender);
            }

            let smtpFrom = messageData.meta.from;
            if (smtpFrom) {
                smtpFrom = addressparser(smtpFrom);
                tools.decodeAddresses(smtpFrom);
            }

            let smtpTo = messageData.meta.to;
            if (smtpTo) {
                smtpTo = addressparser(smtpTo);
                tools.decodeAddresses(smtpTo);
            }

            let replyTo = parsedHeader['reply-to'];
            if (replyTo) {
                tools.decodeAddresses(replyTo);
            }

            let to = parsedHeader.to;
            if (to) {
                tools.decodeAddresses(to);
            }

            let cc = parsedHeader.cc;
            if (cc) {
                tools.decodeAddresses(cc);
            }

            let list;
            if (parsedHeader['list-id'] || parsedHeader['list-unsubscribe']) {
                let listId = parsedHeader['list-id'];
                if (listId) {
                    listId = addressparser(listId.toString());
                    tools.decodeAddresses(listId);
                    listId = listId.shift();
                }

                let listUnsubscribe = parsedHeader['list-unsubscribe'];
                if (listUnsubscribe) {
                    listUnsubscribe = addressparser(listUnsubscribe.toString());
                    tools.decodeAddresses(listUnsubscribe);
                }

                list = {
                    id: listId,
                    unsubscribe: listUnsubscribe
                };
            }

            let expires;
            if (messageData.exp) {
                expires = new Date(messageData.rdate).toISOString();
            }

            messageData.html = (messageData.html || []).map(html => html.replace(/attachment:(ATT\d+)/g, (str, aid) => attachmentUrl + '/' + aid));

            messageData.text = ((messageData.text || '') + (messageData.textFooter || '')).replace(
                /attachment:(ATT\d+)/g,
                (str, aid) => attachmentUrl + '/' + aid
            );

            let ensureSeen = done => {
                if (!messageData.unseen) {
                    return done();
                }
                // we need to mark this message as seen
                return db.messageHandler.update(messageData.user, mailbox, messageData.uid, { seen: true }, err => {
                    if (err) {
                        // ignore
                    } else {
                        messageData.unseen = false;
                    }

                    done();
                });
            };

            ensureSeen(() => {
                let response = {
                    success: true,
                    id: message,
                    messageUrl,
                    attachmentUrl,
                    uid: messageData.uid,
                    mailbox: messageData.mailbox,
                    user: messageData.user,
                    from,
                    sender,
                    smtpFrom,
                    smtpTo,
                    meta: messageData.meta,
                    replyTo,
                    to,
                    cc,
                    publicId,
                    subject,
                    messageId: messageData.msgid,
                    date: messageData.hdate.toISOString(),
                    inReplyTo: parsedHeader['in-reply-to'],
                    list,
                    expires,
                    seen: !messageData.unseen,
                    deleted: !messageData.undeleted,
                    flagged: messageData.flagged,
                    draft: messageData.draft,
                    html: messageData.html,
                    text: messageData.text,
                    attachments: (messageData.attachments || []).map(attachment => {
                        attachment.url = attachmentUrl + '/' + attachment.id;
                        return attachment;
                    })
                };

                let parsedContentType = parsedHeader['content-type'];
                if (parsedContentType) {
                    response.contentType = {
                        value: parsedContentType.value
                    };
                    if (parsedContentType.hasParams) {
                        response.contentType.params = parsedContentType.params;
                    }

                    if (parsedContentType.subtype === 'encrypted') {
                        response.encrypted = true;
                    }
                }

                return callback(null, response);
            });
        }
    );
}

function renderMessage(req, res, next, data) {
    let mailbox = new ObjectID(data.mailboxId);
    let message = data.messageId ? new ObjectID(data.messageId) : false;
    let uid = data.uid;

    getMessage(req.params.id, mailbox, message, uid, data.usePrivateUrl, (err, messageData) => {
        if (err) {
            return next(err);
        }

        let warnPublic = data.warnPublic;

        let info = [];
        let envelope = [];

        if (messageData.subject) {
            info.push({
                key: 'Subject',
                value: messageData.subject
            });
        }

        if (messageData.smtpFrom) {
            envelope.push({
                key: 'MAIL FROM',
                isHtml: true,
                value: messageTools.getAddressesHTML(messageData.smtpFrom)
            });
        }

        if (messageData.smtpTo) {
            envelope.push({
                key: 'RCPT TO',
                isHtml: true,
                value: messageTools.getAddressesHTML(messageData.smtpTo)
            });
        }

        if (messageData.meta.origin) {
            envelope.push({
                key: 'Address',
                value: messageData.meta.origin
            });
        }

        if (messageData.meta.transhost) {
            envelope.push({
                key: 'Greeting',
                value: messageData.meta.transhost
            });
        }

        if (messageData.meta.originhost) {
            envelope.push({
                key: 'Hostname',
                value: messageData.meta.originhost
            });
        }

        if (messageData.meta.transtype) {
            envelope.push({
                key: 'Protocol',
                value: messageData.meta.transtype
            });
        }

        envelope.push({
            key: 'Received time',
            isDate: true,
            value: new Date(messageData.meta.time).toISOString()
        });

        if (messageData.from) {
            info.push({
                key: 'From',
                isHtml: true,
                value: messageTools.getAddressesHTML(messageData.from)
            });
        }

        if (messageData.sender) {
            info.push({
                key: 'From',
                isHtml: true,
                value: messageTools.getAddressesHTML(messageData.sender)
            });
        }

        if (messageData.replyTo) {
            info.push({
                key: 'Reply To',
                isHtml: true,
                value: messageTools.getAddressesHTML(messageData.replyTo)
            });
        }

        if (messageData.to) {
            info.push({
                key: 'To',
                isHtml: true,
                value: messageTools.getAddressesHTML(messageData.to)
            });
        }

        if (messageData.cc) {
            info.push({
                key: 'Cc',
                isHtml: true,
                value: messageTools.getAddressesHTML(messageData.cc)
            });
        }

        if (messageData.bcc) {
            info.push({
                key: 'Bcc',
                isHtml: true,
                value: messageTools.getAddressesHTML(messageData.bcc)
            });
        }

        info.push({
            key: 'Time',
            isDate: true,
            value: messageData.date
        });

        info.push({
            key: 'Message-ID',
            value: messageData.messageId
        });

        if (messageData.inReplyTo) {
            info.push({
                key: 'In-Reply-To',
                value: messageData.inReplyTo
            });
        }

        res.render('message', {
            id: req.params.id,
            info,
            warnPublic,
            expires: messageData.expires,
            usePrivateUrl: data.usePrivateUrl,
            messageUrl: messageData.messageUrl,
            attachmentUrl: messageData.attachmentUrl,
            activeHeader: req.query.tab === 'header' || !req.query.tab,
            activeEnvelope: req.query.tab === 'envelope',
            envelope,
            hasIframe: true,
            activeMessages: data.usePrivateUrl,
            message: messageData,
            messageJson: JSON.stringify(messageData).replace(/\//g, '\\u002f')
        });
    });
}

function getFilteredMessageCount(db, filter, done) {
    if (Object.keys(filter).length === 1 && filter.mailbox) {
        // try to use cached value to get the count
        return tools.getMailboxCounter(db, filter.mailbox, false, done);
    }

    db.database.collection('messages').count(filter, (err, total) => {
        if (err) {
            return done(err);
        }
        done(null, total);
    });
}

function renderRoute(route, opts) {
    let query = Object.keys(opts || {})
        .filter(key => opts[key])
        .map(key => encodeURIComponent(key) + '=' + encodeURIComponent(opts[key]))
        .join('&');
    return route + (query.length ? '?' + query : '');
}

function checkLogin(req, res, next) {
    if (!req.user) {
        req.flash('danger', 'Authentication required');
        return res.redirect('/login');
    }
    next();
}

function renderSource(req, res, next, data) {
    let mailbox = new ObjectID(data.mailboxId);
    let message = data.messageId ? new ObjectID(data.messageId) : false;
    let uid = data.uid;

    let query = {};
    if (message) {
        query._id = message;
    }
    query.mailbox = mailbox;
    query.uid = uid;

    db.database.collection('messages').findOne(
        query,
        {
            fields: {
                _id: true,
                user: true,
                mailbox: true,
                uid: true,
                mimeTree: true
            }
        },
        (err, messageData) => {
            if (err) {
                return next(err);
            }

            if (!messageData) {
                let err = new Error('This message does not exist');
                err.status = 404;
                return next(err);
            }

            let warnPublic = data.warnPublic;

            let publicId = etherealId.get(messageData.mailbox.toString(), messageData._id.toString(), messageData.uid);
            let messageUrl = data.usePrivateUrl ? '/messages/' + mailbox + '/' + uid : '/message/' + publicId;

            let parsedHeader = (messageData.mimeTree && messageData.mimeTree.parsedHeader) || {};

            let subject = parsedHeader.subject;
            try {
                subject = libmime.decodeWords(subject);
            } catch (E) {
                //
            }

            let raw = db.messageHandler.indexer.rebuild(messageData.mimeTree);
            if (!raw || raw.type !== 'stream' || !raw.value) {
                let err = new Error('This message does not exist');
                err.status = 404;
                return next(err);
            }

            let chunks = [];
            let chunklen = 0;
            let ignore = false;
            let ignoreBytes = 0;

            raw.value.on('readable', () => {
                let chunk;
                while ((chunk = raw.value.read()) !== null) {
                    if (!ignore) {
                        chunks.push(chunk);
                        chunklen += chunk.length;
                        if (chunklen > 728 * 1024) {
                            ignore = true;
                        }
                    } else {
                        ignoreBytes += chunk.length;
                    }
                }
            });

            raw.value.once('error', err => {
                err.message = 'Database error. ' + err.message;
                err.status = 500;
                return next(err);
            });

            raw.value.once('end', () => {
                if (ignoreBytes) {
                    let chunk = Buffer.from('\n<+ ' + humanize.filesize(ignoreBytes) + ' ...>');
                    chunks.push(chunk);
                    chunklen += chunk.length;
                }

                let source = '<span>' + he.encode(Buffer.concat(chunks, chunklen).toString()).replace(/\r?\n/g, '</span>\n<span>') + '</span>';

                res.render('source', {
                    messageUrl,
                    warnPublic,
                    subject,
                    source,
                    activeMessages: data.usePrivateUrl
                });
            });
        }
    );
}

function renderAttachment(req, res, next, data) {
    let mailbox = new ObjectID(data.mailboxId);
    let message = data.messageId ? new ObjectID(data.messageId) : false;
    let uid = data.uid;
    let aid = req.params.aid;

    let query = {};
    if (message) {
        query._id = message;
    }
    query.mailbox = mailbox;
    query.uid = uid;

    db.database.collection('messages').findOne(
        query,
        {
            fields: {
                _id: true,
                user: true,
                attachments: true,
                'mimeTree.attachmentMap': true
            }
        },
        (err, messageData) => {
            if (err) {
                err.message = 'Database error.' + err.message;
                err.status = 500;
                return next(err);
            }
            if (!messageData) {
                let err = new Error('This message does not exist');
                err.status = 404;
                return next(err);
            }

            let attachmentId = messageData.mimeTree.attachmentMap && messageData.mimeTree.attachmentMap[aid];
            if (!attachmentId) {
                let err = new Error('This attachment does not exist');
                err.status = 404;
                return next(err);
            }

            db.messageHandler.attachmentStorage.get(attachmentId, (err, attachmentData) => {
                if (err) {
                    err.message = 'Database error.' + err.message;
                    err.status = 500;
                    return next(err);
                }

                res.writeHead(200, {
                    'Content-Type': attachmentData.contentType || 'application/octet-stream'
                });

                let attachmentStream = db.messageHandler.attachmentStorage.createReadStream(attachmentId, attachmentData);

                attachmentStream.once('error', err => res.emit('error', err));

                if (attachmentData.transferEncoding === 'base64') {
                    attachmentStream.pipe(new libbase64.Decoder()).pipe(res);
                } else if (attachmentData.transferEncoding === 'quoted-printable') {
                    attachmentStream.pipe(new libqp.Decoder()).pipe(res);
                } else {
                    attachmentStream.pipe(res);
                }
            });
        }
    );
}

function getId() {
    let id;
    let tries = 0;
    while (++tries < 100) {
        id = base32.encode(crypto.randomBytes(10)).toLowerCase();
        if (/^[a-z]/.test(id)) {
            return id;
        }
    }
    return id;
}
