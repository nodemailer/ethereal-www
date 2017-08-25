'use strict';

const fs = require('fs');
const he = require('he');
const marked = require('marked');
const Handlebars = require('handlebars');
const docs = new Map();

module.exports = (path, data) => {
    if (docs.has(path)) {
        return docs.get(path)(data || {});
    }
    let md = __dirname + '/../docs/' + path + '.md';
    let result = '';
    try {
        let source = marked(fs.readFileSync(md, 'utf-8'));
        let template = Handlebars.compile(source);
        docs.set(path, template);
        result = template(data || {});
    } catch (E) {
        result = '<strong>' + he.encode(E.message) + '</strong>';
    }

    return result;
};
