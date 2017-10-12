> Ethereal is a free e-mail catching service, mostly aimed at (but not limited to) [Nodemailer](https://nodemailer.com/about/) users. Configure Ethereal as your outbound SMTP service and start sending mail. Nothing is actually delivered, all emails are caught and stored for review. What makee Ethereal stand out is the IMAP support and the freedom to create as many accounts as you wish, even programmatically.

#### 1\. Why would someone want to use Ethereal?

Ethereal is mostly useful for app development. Instead of configuring a real email account for sending mail your application can automatically request an Ethereal test account and use it for message delivery. You get the same experience as using any other mail service provider, you can configure it as an outbound mail server and send your transactional or marketing emails through the Ethereal service. Unlike real email services Ethereal only accepts mail for delivery but never actually delivers anything. Instead you get an URL (or use your favorite IMAP app) to conveniently preview the sent messages.

#### 2\. How can I use it

Ethereal accounts can be created by Nodemailer using the `nodemailer.createTestAccount(callback)` method (or if you want to create accounts the old way, then from the [login page](/login)). This method requests a new account (or uses a cached account) from Ethereal and returns related information. All Ethereal accounts look exactly as any other SMTP service account. For applications trying to send mail there's no difference whatsoever.

#### 3\. Where is the message URL

Once you have sent your message using an Ethereal account, you can get message preview URL with the `nodemailer.getTestMessageUrl(info)` method (the `info` object is the response from `sendMail`). Open that URL in your web browser to see the sent message. Message URLs are public and do not require authentication. Or to be more correct, the authentication info is encoded into the URL.

Alternatively you can log in either [here](/login) and see the messages page or use your favorite IMAP/POP3 client to access the sent messages.

#### 4\. Should I generate a new account for every message

You sure don't have to even though you can. Account details are cached in memory so if you make two account requests from the same process you only create one new account. If you do not want to list sent messages then you don't have to worry about accounts, if you do though, then you should store the account details somewhere and reuse these. Normally you would generate a single account and use it for all your testing.

#### 5\. How long are the messages stored

Messages are stored for 7 days, after what these are deleted.

#### 6\. Are there any rate limits?

Currently not. The server is not the fastest one so you probably can't send too many messages at once to it anyway.

#### 7\. I signed in to the account using IMAP. Where are all the messages?

All messages, both sent and received can be found from the _INBOX_ folder (unless 7 days has passed and the message is already deleted).

#### 8\. How is this sustainable

Ethereal Email service is funded by the ads displayed on [Nodemailer.com](https://nodemailer.com/about/).

#### 9\. Must I use Nodemailer for Ethereal?

No, you can use any mail client or library that supports SMTP, be it PHPMailer or even Outlook Express.

#### 10\. I'm over quota! Help!

Every address gets a quota of 100MB message storage. Once that quota is full you can not receive any more messages to your account address. To clean up some space you can either use an IMAP client (using POP3 does not work) and delete older messages. Alternatively you could just wait up to 7 days when all stored messages expire automatically.

#### 11\. Is there an example?

Yes, below is a screenshot of an email caught by Ethereal

![](https://cldup.com/D5Cj_C1Vw3.png)
