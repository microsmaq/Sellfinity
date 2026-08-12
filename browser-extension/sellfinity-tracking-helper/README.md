# Sellfinity Amazon Tracking Helper

## Install in Chrome

1. Download and unzip `sellfinity-tracking-helper.zip`.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the unzipped `sellfinity-tracking-helper` folder.

## Use

1. Sign in to Amazon in Chrome.
2. Open Sellfinity Fulfillment.
3. Click **Open Amazon tracking** for an order.
4. When a supported tracking number appears, the extension returns to Sellfinity and fills that order's tracking field.
5. Review the number and click **Save & mark shipped**.

You can also click **Refresh Amazon & eBay** in Sellfinity. Version 1.1 checks
all visible unresolved Amazon tracking links in the background and saves every
tracking ID it finds. Keep Amazon signed in while the check runs.

After updating the extension files, click the extension's **Reload** button on
`chrome://extensions` before trying it again.

The extension does not use clipboard access. It only reads supported
Amazon/carrier tracking pages opened from Sellfinity and submits tracking to
the matching fulfillment row.
