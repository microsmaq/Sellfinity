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

You can also click **Refresh Amazon & eBay** in Sellfinity. Version 1.2.0 checks
all unresolved Amazon tracking links in the background, including links found
by the email scan during that same refresh, and saves every tracking ID it
finds. Its progress is shown inside the animated Fulfillment refresh panel.
Keep Amazon signed in while the check runs.

Version 1.2.0 also supports **Check Amazon prices** in Fulfillment. It opens one
signed-in Amazon page per unique awaiting-purchase product, reads the current
item price and any clearly displayed shipping charge, then saves the costs and
recalculates the order profit. If Amazon does not clearly show shipping, the
existing shipping amount is preserved rather than incorrectly assuming it is
free.

After updating the extension files, click the extension's **Reload** button on
`chrome://extensions` before trying it again.

The extension does not use clipboard access. It only reads supported
Amazon/carrier tracking pages opened from Sellfinity and submits tracking to
the matching fulfillment row.
