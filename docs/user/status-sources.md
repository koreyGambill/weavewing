# External tool status

Status sources show the health of external tools in the inbox's Status panel in the web and
desktop apps. Open a source to see its current summary, individual checks, and last state transition.
Follow its tool link for history.

Open **Settings > Status sources**, select an environment, and choose **Add source**. Checks run
from that environment's server, so `127.0.0.1` refers to the server's machine. Configuration
requires the **settings** permission; snoozing needs **operate**. Agents can read status but cannot change sources or run
commands through them.

## Add Stormwing

Choose **Wing status**, name it **Stormwing**, and use
`http://127.0.0.1:4791/api/status`. Choose an icon or **Site favicon**, then save. Stormwing must
be running on the same machine as the selected T3 Code server for this URL to work.

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

## Notifications and snoozing

Notifications follow your notification preferences. A source alerts when it leaves OK for a
warning or failure, and when it recovers to OK. Repeated checks in the same state do not repeat
the alert. Connecting to a server does not replay its previous transitions.

Choose **Snooze** and select a time or duration to mute a source's notifications while its status continues updating.
Choose **Unsnooze** to resume early. Remove a source to stop checking it. No sources are added
automatically. Status sources are available in web and desktop. Mobile configuration and status
display are not supported.
