import { useEffect, useState, type ImgHTMLAttributes } from 'react';
import { assetRef, cachedAssetUrl, decryptingAssets, resolveAsset } from '../lib/assets';

/**
 * An <img> of an upload or drawing (a thumbnail, say). In an encrypted library it's decrypted first,
 * so it shows a moment later, or not at all if it can't be (offline and never opened, say).
 */
export function AssetImg({ src, ...rest }: Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & { src: string }) {
  const decrypt = decryptingAssets() && assetRef(src) !== null;
  const [shown, setShown] = useState<string | null>(() => (decrypt ? cachedAssetUrl(src) : src));

  useEffect(() => {
    if (!decrypt) {
      setShown(src);
      return;
    }
    const cached = cachedAssetUrl(src);
    if (cached) {
      setShown(cached);
      return;
    }
    let live = true;
    setShown(null);
    resolveAsset(src).then(
      (url) => live && setShown(url),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [src, decrypt]);

  if (!shown) return <img {...rest} alt={rest.alt ?? ''} data-pending="" />;
  return <img {...rest} src={shown} />;
}
