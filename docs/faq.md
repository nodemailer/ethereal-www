## 1\. Why would someone want to use Ethereal?

Ethereal is mostly useful for app development. Instead of configuring a real email account for sending mail your application can request an Ethereal test account and use it for message delivery. You get the same experience as using any other mail service, you can configure it as an outbound mail server and send your transactional or marketing emails through the Ethereal service. Unlike real email services Ethereal only accepts mail for delivery but never actually delivers anything. Instead you get an URL (or use your favorite IMAP app) to conveniently preview the sent messages.

## 2\. How can I use it

Ethereal accounts can be created by Nodemailer using the `nodemailer.createTestAccount(callback)` method. This method requests a new account (or uses a cached account) from Ethereal and returns related information. All Ethereal accounts look exactly as any other SMTP service account, for an application trying to send mail there's no difference whatsoever.

## 3\. Where is the message URL

Once you have sent your message using an Ethereal account, you can get message information with the `nodemailer.getTestMessageUrl(info)` method (the `info` object is the response from `sendMail`). Just print the result of that method to console to see the details of the delivery (including account info if you want to store it for future use).

Message URLs are public and do not require authentication. Or actually, the authentication info is encoded into the URL.

## 4\. Should I generate a new account for every message

You sure don't have to even though you can if you wanted to. Account details are cached in memory so if you make two account requests from the same process you only create one new account. If you do not want to list sent messages then you don't have to worry about accounts, if you do though, then you should store the account details somewhere and reuse these.

## 5\. How long are the messages stored

Messages are stored for 7 days

## 6\. Are there any rate limits?

Currently not. The server is not the fastest one so you can't send too many messages to it anyway.

## 7\. I logged into the account using IMAP. Where are the messages?

All sent messages can be found from the _Sent Mail_ folder (unless 7 days has passed and the message is already deleted). INBOX includes messages that are sent to the testing account address from other email addresses as Ethereal can handle incoming email as well. Inbound messages also expire after 7 days.
