import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpEffect from "effect/http/HttpEffect";

import * as TailnetConnect from "./TailnetConnect.ts";
import {
  renderEnvironmentsPage,
  renderPairingConfirmPage,
  renderPairingPage,
  renderRefusalPage,
  TAILNET_PAGE_HEADERS,
} from "./tailnetHtml.ts";

const html = (body: string, status = 200) =>
  HttpServerResponse.text(body, { status, headers: TAILNET_PAGE_HEADERS });

const refusalStatus = (reason: TailnetConnect.TailnetConnectRefusal) =>
  reason === "disabled"
    ? 404
    : reason === "rate_limited"
      ? 429
      : reason === "tailscale_unavailable"
        ? 503
        : 403;

/** The socket's own ends, never forwarding headers: Tailscale names the caller by its address. */
const tailnetRequest = Effect.map(
  HttpServerRequest.HttpServerRequest,
  (request): TailnetConnect.TailnetRequest => {
    const socket = (
      request.source as {
        readonly socket?: { readonly remoteAddress?: string; readonly localAddress?: string };
      }
    ).socket;
    return {
      remoteAddress: socket?.remoteAddress,
      localAddress: socket?.localAddress,
      host: request.headers.host,
    };
  },
);

/**
 * Whether a browser sent this for another site, which would act as the tailnet device. Another site
 * cannot read a navigation, so pages allow one. Minting also wants the confirm form's navigation;
 * that is hygiene, not a boundary, since this origin's scripts are trusted anyway.
 */
const isCrossSite = (request: HttpServerRequest.HttpServerRequest, use: "page" | "mint") => {
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== `http://${request.headers.host ?? ""}`) return true;
  const site = request.headers["sec-fetch-site"];
  const mode = request.headers["sec-fetch-mode"];
  if (use === "mint") {
    return (
      (site !== undefined && site !== "same-origin") || (mode !== undefined && mode !== "navigate")
    );
  }
  return site !== undefined && site !== "same-origin" && site !== "none" && mode !== "navigate";
};

const CORS_RESPONSE_HEADERS = [
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-expose-headers",
  "access-control-max-age",
];

/**
 * Whatever spelling of the path the router matched, no other site may read these responses. Runs
 * after the browser API's CORS handler, which registers before any route does.
 */
const withoutCors = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    CORS_RESPONSE_HEADERS.reduce(
      (stripped, header) => HttpServerResponse.removeHeader(stripped, header),
      response,
    ),
  ),
);

const refused = (error: TailnetConnect.TailnetConnectRefusedError, listLink: boolean) =>
  Effect.succeed(
    html(
      renderRefusalPage({
        ...(error.reason === "disabled"
          ? {
              heading: "Tailnet pairing is off on this server",
              message: `Turn it on in Settings → Privacy for ${error.detail ?? "this environment"}.`,
            }
          : { message: error.message }),
        listLink,
      }),
      refusalStatus(error.reason),
    ),
  );

const refuseCrossSite = (use: "page" | "mint") =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    isCrossSite(request, use)
      ? Effect.fail(new TailnetConnect.TailnetConnectRefusedError({ reason: "cross_site" }))
      : Effect.void,
  );

export const layer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const service = yield* TailnetConnect.TailnetConnect;

    yield* router.add(
      "GET",
      TailnetConnect.TAILNET_PAGE_PATH,
      Effect.gen(function* () {
        yield* withoutCors;
        yield* refuseCrossSite("page");
        const page = yield* service.listEnvironments(yield* tailnetRequest);
        return html(renderEnvironmentsPage(page));
      }).pipe(Effect.catchTags({ TailnetConnectRefusedError: (error) => refused(error, false) })),
    );

    yield* router.add(
      "GET",
      TailnetConnect.TAILNET_PAIR_PATH,
      Effect.gen(function* () {
        yield* withoutCors;
        yield* refuseCrossSite("page");
        return html(
          renderPairingConfirmPage(yield* service.describePairing(yield* tailnetRequest)),
        );
      }).pipe(Effect.catchTags({ TailnetConnectRefusedError: (error) => refused(error, true) })),
    );

    yield* router.add(
      "POST",
      TailnetConnect.TAILNET_PAIR_PATH,
      Effect.gen(function* () {
        yield* withoutCors;
        yield* refuseCrossSite("mint");
        const pairing = yield* service.issuePairing(yield* tailnetRequest);
        const now = yield* DateTime.now;
        const expiresInMinutes = Math.max(
          1,
          Math.round(Duration.toMinutes(DateTime.distance(now, pairing.expiresAt))),
        );
        return html(renderPairingPage({ pairing, expiresInMinutes }));
      }).pipe(
        Effect.catchTags({
          TailnetConnectRefusedError: (error) => refused(error, true),
          TailnetPairingIssueError: (error) =>
            Effect.logError("tailnet pairing failed", { cause: error.cause }).pipe(
              Effect.as(html(renderRefusalPage({ message: error.message, listLink: true }), 500)),
            ),
        }),
      ),
    );
  }),
);
