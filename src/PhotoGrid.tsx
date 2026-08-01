import { Image, StyleSheet, View } from 'react-native';

import { colors } from './theme';
import type { NoteAttachment } from './types';

export function PhotoGrid({
  attachments,
  compact = false,
}: {
  attachments: NoteAttachment[];
  compact?: boolean;
}) {
  const photos = attachments.slice(0, 4);
  if (!photos.length) return null;
  if (photos.length === 1) {
    return (
      <Image
        accessibilityLabel="记录中的图片"
        resizeMode="cover"
        source={{ uri: photos[0].uri }}
        style={[styles.hero, compact && styles.heroCompact]}
      />
    );
  }
  return (
    <View style={[styles.grid, compact && styles.gridCompact]}>
      {photos.map((photo) => (
        <Image
          accessibilityLabel="记录中的图片"
          key={photo.id}
          resizeMode="cover"
          source={{ uri: photo.uri }}
          style={styles.tile}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  hero: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: 20,
    backgroundColor: colors.line,
  },
  heroCompact: {
    aspectRatio: 16 / 9,
    borderRadius: 15,
    marginBottom: 12,
  },
  grid: {
    width: '100%',
    aspectRatio: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: colors.line,
  },
  gridCompact: {
    aspectRatio: 16 / 9,
    borderRadius: 15,
    marginBottom: 12,
  },
  tile: {
    width: '49.4%',
    height: '49.4%',
    flexGrow: 1,
    backgroundColor: colors.line,
  },
});
