# External tool status

Status sources show the health of external tools under **Status** in the right tools sidebar in the web and
desktop apps. Open a source to see its current summary, individual checks, and last state transition.
Follow its tool link for history.

Open **Settings > Status sources**, select an environment, and choose **Add source**. Checks run
from that environment's server, so `127.0.0.1` refers to the server's machine. Configuration
requires the **settings** permission; snoozing needs **operate**. Agents can read status but cannot change sources or run
commands through them.

Drag a source by its handle in **Settings > Status sources** to change the order the Status panel
shows. Linked machines show shared sources in the same order.

## Add Stormwing

Choose **Wing status**, name it **Stormwing**, and use
`http://127.0.0.1:4791/api/status`. Choose an icon or **Site favicon**, then save. Stormwing must
be running on the same machine as the selected Weavewing server for this URL to work.

## Add an HTTP health URL

Choose **HTTP health** and enter a health endpoint, such as `https://example.com/health`.
A successful HTTP response means OK. Other response codes mean failed, and a timeout means
unknown. For authenticated endpoints, enter request headers as JSON, such as
`{"Authorization":"Bearer your-token"}`. Credentials stay in the server's secret store.

Checks default to every 60 seconds, with a minimum interval of 30 seconds. Failed requests back
off to avoid repeatedly hitting an unavailable tool. Editing a source leaves its saved URL or
command and headers intact when those fields are blank. Enter `{}` to clear saved headers.

## Local commands and webhooks

A **Local command** source runs a command on the server with a timeout. It can print the same
JSON status format as a Wing status endpoint. Otherwise, exit code 0 means OK and any other exit
code means failed. Adding or editing a command source also needs the **terminal** permission.

A **Signed webhook** source accepts pushed status. Save it, generate a signing secret, and copy
the endpoint and secret before closing. Replacing the secret invalidates the previous one.
Send the Wing status JSON body with an `updatedAt` timestamp and the header
`x-t3-signature: sha256=<hex HMAC-SHA256 of the exact body bytes using the signing secret>`.
The sender must reach the selected server's endpoint.
The timestamp must be within five minutes of the server's clock.

## Share status with your other machines

Sources are shared by default. Every machine with a linked-environment connection to this
machine (Settings → Labs → **Linked environments**) shows its shared sources under its own
status, named after this machine, and alerts on them like its own. A machine you are already
connected to directly shows its sources once. Links go one way, so link each machine to each
other machine you want alerts from. Turn off **Share with linked machines** in a source's
settings to keep it on this machine.

Shared copies update about once a minute, so a failure that recovers between updates may not
reach other machines. Inbox alerts stay on the machine that runs the check; other machines show
the toast or desktop notification. Snooze or edit a source on the machine that runs it; its
snooze applies everywhere. A machine that stops answering keeps its last status, so a sleeping
laptop does not clear or raise alerts. Removing, expiring or revoking the link removes its
sources.

## Notifications and snoozing

Notifications follow your notification preferences. A source alerts when it leaves OK for a
warning or failure, and when it recovers to OK. Repeated checks in the same state do not repeat
the alert. Connecting to a server does not replay its previous transitions.

The inbox keeps failure alerts as urgent. A warning reaches the inbox after three
consecutive observations in the running server. Recovery and unknown status stay
in the Status view. The warning count resets when the source leaves warning or
the server restarts. Each warning or failure episode raises one inbox alert.
Dismissing it sticks across restarts. When the source leaves that state, its alert
moves to **Dismissed**; a later episode can raise a new alert.

Choose **Snooze** and select a time or duration to mute a source's notifications while its status continues updating.
Choose **Unsnooze** to resume early. Remove a source to stop checking it. No sources are added
automatically. Status sources are available in web and desktop. Mobile configuration and status
display are not supported.
