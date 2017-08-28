'use strict';

const config = require('wild-config');
const express = require('express');
const EtherealId = require('ethereal-id');
const router = new express.Router();
const passport = require('../lib/passport');
const mdrender = require('../lib/mdrender.js');
const db = require('../lib/db');
const libqp = require('libqp');
const he = require('he');
const libbase64 = require('libbase64');
const libmime = require('libmime');
const tools = require('wildduck/lib/tools');
const messageTools = require('../lib/message-tools');
const addressparser = require('addressparser');
const humanize = require('humanize');
const ObjectID = require('mongodb').ObjectID;
const etherealId = new EtherealId({
    secret: config.service.msgidSecret,
    hash: config.service.msgidHash
});

router.use(passport.csrf);

/* GET home page. */
router.get('/', (req, res) => {
    res.render('index', {
        activeHome: true,
        page: mdrender('index', { title: 'test' })
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

    let mailbox = new ObjectID(data.mailboxId);
    let message = new ObjectID(data.messageId);
    let uid = data.uid;

    db.database.collection('messages').findOne({
        _id: message,
        mailbox,
        uid
    }, {
        fields: {
            _id: true,
            user: true,
            mimeTree: true
        }
    }, (err, messageData) => {
        if (err) {
            return next(err);
        }

        if (!messageData) {
            let err = new Error('This message does not exist');
            err.status = 404;
            return next(err);
        }

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
                id: req.params.id,
                subject,
                source
            });
        });
    });
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

    db.database.collection('messages').findOne({
        _id: message,
        mailbox,
        uid
    }, {
        fields: {
            _id: true,
            user: true,
            mimeTree: true
        }
    }, (err, messageData) => {
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
    });
});

router.get('/message/:id', (req, res, next) => {
    let data = etherealId.validate(req.params.id);
    if (!data) {
        let err = new Error('Invalid or unknown message identifier');
        err.status = 404;
        return next(err);
    }

    let mailbox = new ObjectID(data.mailboxId);
    let message = new ObjectID(data.messageId);
    let uid = data.uid;

    getMessage(req.params.id, mailbox, message, uid, (err, messageData) => {
        if (err) {
            return next(err);
        }

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
            key: 'Time',
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

        messageData.html = (messageData.html || [])
            .map(html => html.replace(/attachment:([a-f0-9]+)\/(ATT\d+)/g, (str, mid, aid) => '/attachment/' + req.params.id + '/' + aid));

        res.render('message', {
            id: req.params.id,
            info,
            activeHeader: req.query.tab === 'header' || !req.query.tab,
            activeEnvelope: req.query.tab === 'envelope',
            envelope,
            hasIframe: true,
            message: messageData,
            messageJson: JSON.stringify(messageData).replace(/\//g, '\\u002f')
        });
    });
});

router.get('/attachment/:id/:aid', (req, res, next) => {
    let data = etherealId.validate(req.params.id);
    if (!data) {
        let err = new Error('Invalid or unknown message identifier');
        err.status = 404;
        return next(err);
    }

    let mailbox = new ObjectID(data.mailboxId);
    let message = new ObjectID(data.messageId);
    let uid = data.uid;
    let aid = req.params.aid;

    db.database.collection('messages').findOne({
        _id: message,
        mailbox,
        uid
    }, {
        fields: {
            _id: true,
            user: true,
            attachments: true,
            'mimeTree.attachmentMap': true
        }
    }, (err, messageData) => {
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

            let attachmentStream = db.messageHandler.attachmentStorage.createReadStream(attachmentId);

            attachmentStream.once('error', err => res.emit('error', err));

            if (attachmentData.transferEncoding === 'base64') {
                attachmentStream.pipe(new libbase64.Decoder()).pipe(res);
            } else if (attachmentData.transferEncoding === 'quoted-printable') {
                attachmentStream.pipe(new libqp.Decoder()).pipe(res);
            } else {
                attachmentStream.pipe(res);
            }
        });
    });
});

module.exports = router;

function getMessage(id, mailbox, message, uid, callback) {
    db.database.collection('messages').findOne({
        _id: message,
        mailbox,
        uid
    }, {
        fields: {
            _id: true,
            user: true,
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
            html: true
        }
    }, (err, messageData) => {
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

        messageData.html = (messageData.html || [])
            .map(html => html.replace(/attachment:([a-f0-9]+)\/(ATT\d+)/g, (str, mid, aid) => '/attachment/' + id + '/' + aid));

        let ensureSeen = done => {
            if (!messageData.unseen) {
                return done();
            }
            // we need to mark this message as seen
            return db.messageHandler.update(messageData.user, mailbox, message, { seen: true }, err => {
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
                from,
                sender,
                smtpFrom,
                smtpTo,
                meta: messageData.meta,
                replyTo,
                to,
                cc,
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
                attachments: (messageData.attachments || []).map(attachment => {
                    attachment.url = '/attachment/' + id + '/' + attachment.id;
                    return attachment;
                }),
                raw: '/message/' + id + '/message.eml'
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
    });
}
