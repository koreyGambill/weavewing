// The sign-in app's own icon, as GitHub shows the "T3 Code for GitHub" app, whatever this build's channel.
import appIconUrl from "../../../../assets/prod/t3-black-web-apple-touch-180.png";

export function SourceControlAppIcon(props: { readonly className?: string }) {
  return <img src={appIconUrl} alt="" className={props.className} />;
}
