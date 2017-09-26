# Ethereal-WWW

**What is this?**

This is the front end service for https://ethereal.email

## Requirements

* Node.js v6+
* MongoDB 3+
* Redis

## Components

To run Ethereal you need to have the following components:

1. ethereal-www (this application) to show the web interface
2. [ethereal-msa](https://github.com/andris9/ethereal-msa) to accept mail
3. [Wild Duck Mail Server](https://github.com/nodemailer/wildduck) to store user accounts and messages

## Usage

Once you have started Wild Duck Mail Server and ethereal-msa, install dependencies and start the app:

```
$ npm install --production
$ node server.js
```

After you have started the server, head to http://localhost:5999/

## License

[European Union Public License 1.1](http://ec.europa.eu/idabc/eupl.html).
