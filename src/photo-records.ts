import { Directory, File, Paths } from 'expo-file-system';
import type { ImagePickerAsset } from 'expo-image-picker';

import { createLocalId } from './note-utils';
import type { NoteAttachment } from './types';

const MEDIA_DIRECTORY = 'remind-media';

export type PendingPhoto = Pick<
  NoteAttachment,
  'id' | 'uri' | 'width' | 'height' | 'sortOrder'
>;

export function attachmentMap(
  attachments: NoteAttachment[],
): Record<string, NoteAttachment[]> {
  return attachments.reduce<Record<string, NoteAttachment[]>>(
    (result, attachment) => {
      (result[attachment.noteId] ??= []).push(attachment);
      return result;
    },
    {},
  );
}

export function imageExtension(asset: ImagePickerAsset): string {
  const fromName = asset.fileName?.match(/\.([a-zA-Z0-9]{2,5})$/)?.[1];
  if (fromName) return fromName.toLowerCase() === 'jpeg' ? 'jpg' : fromName.toLowerCase();
  if (asset.mimeType === 'image/png') return 'png';
  if (asset.mimeType === 'image/heic') return 'heic';
  if (asset.mimeType === 'image/webp') return 'webp';
  return 'jpg';
}

export function persistPickedPhotos(assets: ImagePickerAsset[]): PendingPhoto[] {
  const directory = new Directory(Paths.document, MEDIA_DIRECTORY);
  if (!directory.exists) directory.create();

  return assets.slice(0, 4).map((asset, sortOrder) => {
    const id = createLocalId();
    const destination = new File(directory, `${id}.${imageExtension(asset)}`);
    new File(asset.uri).copy(destination);
    return {
      id,
      uri: destination.uri,
      width: Math.max(1, asset.width),
      height: Math.max(1, asset.height),
      sortOrder,
    };
  });
}

export function removePersistedPhotos(photos: PendingPhoto[]): void {
  const directoryUri = `${new Directory(Paths.document, MEDIA_DIRECTORY).uri.replace(/\/$/, '')}/`;
  for (const photo of photos) {
    if (!photo.uri.startsWith(directoryUri)) continue;
    try {
      const file = new File(photo.uri);
      if (file.exists) file.delete();
    } catch {
      // A failed cleanup must not prevent the note itself from being deleted.
    }
  }
}
