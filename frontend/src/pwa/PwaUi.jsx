import React, { useState } from 'react';
import { Download, WifiOff, CloudOff, RefreshCw, CheckCircle2, Share, SquarePlus, X } from 'lucide-react';
import { useConnectivity, useInstall, useServiceWorkerUpdate } from './usePwa';

/** Banners: offline / unreachable / reconnected / update available. Data changes are online-only; nothing is queued. */
export function PwaStatus({ onReconnect }) {
  const { status, recheck } = useConnectivity(onReconnect);
  const { updateAvailable, applyUpdate } = useServiceWorkerUpdate();
  return <>
    {status === 'offline' && <div className="pwa-banner offline" role="alert"><WifiOff size={16}/><span><b>You're offline.</b> Live snack data can't be loaded and changes can't be saved until you reconnect.</span></div>}
    {status === 'unreachable' && <div className="pwa-banner offline" role="alert"><CloudOff size={16}/><span><b>Can't reach the server.</b> Your device is online but Supabase isn't responding. Changes are not being saved.</span><button onClick={recheck}>Retry</button></div>}
    {status === 'reconnected' && <div className="pwa-banner ok" role="status"><CheckCircle2 size={16}/><span><b>Back online.</b> Live data was refreshed.</span></div>}
    {updateAvailable && <div className="pwa-banner update" role="status"><RefreshCw size={16}/><span><b>A new version is available.</b> Finish any entry in progress, then refresh to update.</span><button onClick={applyUpdate}>Refresh now</button></div>}
  </>;
}

export function InstallButton({ className = 'outline pwa-install' }) {
  const { mode, install } = useInstall();
  const [help, setHelp] = useState(false);
  if (mode === 'none') return null;
  return <>
    <button type="button" className={className} onClick={mode === 'native' ? install : () => setHelp(true)}><Download size={15}/> Install App</button>
    {help && <div className="pwa-modal-back" onClick={() => setHelp(false)}><div className="pwa-modal" role="dialog" aria-label="Install on iPhone" onClick={e => e.stopPropagation()}>
      <button type="button" className="icon-btn pwa-close" aria-label="Close" onClick={() => setHelp(false)}><X size={16}/></button>
      <h3>Install on iPhone or iPad</h3>
      <ol><li>Open this site in <b>Safari</b>.</li><li>Tap the <b>Share</b> button <Share size={14}/> in the toolbar.</li><li>Choose <b>Add to Home Screen</b> <SquarePlus size={14}/>.</li><li>Tap <b>Add</b>, then launch it from your Home Screen.</li></ol>
    </div></div>}
  </>;
}
