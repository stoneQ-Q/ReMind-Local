import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from './theme';

export function PhotoCaptureSheet({
  onClose,
  onSave,
  visible,
}: {
  onClose: () => void;
  onSave: (caption: string, assets: ImagePicker.ImagePickerAsset[]) => Promise<void>;
  visible: boolean;
}) {
  const insets = useSafeAreaInsets();
  const [assets, setAssets] = useState<ImagePicker.ImagePickerAsset[]>([]);
  const [caption, setCaption] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible) {
      setAssets([]);
      setCaption('');
      setSaving(false);
    }
  }, [visible]);

  const pick = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: 4,
      quality: 0.82,
      exif: false,
    });
    if (!result.canceled) setAssets(result.assets.slice(0, 4));
  };

  const camera = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('需要相机权限', '允许 ReMind 使用相机后，才能拍下这一刻。');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: 0.82,
      exif: false,
    });
    if (!result.canceled && result.assets[0]) setAssets([result.assets[0]]);
  };

  const save = async () => {
    if (!assets.length || !caption.trim() || saving) return;
    setSaving(true);
    try {
      await onSave(caption.trim(), assets);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onClose();
    } catch {
      Alert.alert('图片没有保存下来', '文字和图片还在这里，请重新试一次。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible={visible}>
      <View style={styles.page}>
        <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
          <Pressable hitSlop={10} onPress={onClose}><Text style={styles.cancel}>取消</Text></Pressable>
          <Text style={styles.heading}>图片记录</Text>
          <Pressable disabled={!assets.length || !caption.trim() || saving} hitSlop={10} onPress={() => void save()}>
            <Text style={[styles.save, (!assets.length || !caption.trim() || saving) && styles.disabledText]}>{saving ? '保存中' : '保存'}</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 32 }]} keyboardShouldPersistTaps="handled">
          {assets.length ? (
            <View style={styles.photos}>
              {assets.map((asset, index) => (
                <Image key={`${asset.uri}-${index}`} resizeMode="cover" source={{ uri: asset.uri }} style={assets.length === 1 ? styles.hero : styles.tile} />
              ))}
              <Pressable accessibilityLabel="重新选择图片" onPress={() => void pick()} style={styles.replaceButton}><Text style={styles.replaceText}>重新选择</Text></Pressable>
            </View>
          ) : (
            <View style={styles.emptyPhoto}>
              <Text style={styles.emptyMark}>▧</Text>
              <Text style={styles.emptyTitle}>图片是这一刻的主体</Text>
              <Text style={styles.emptyBody}>ReMind 不会识别画面，只保存你选择的图片和亲手写下的感受。</Text>
              <View style={styles.actions}>
                <Pressable onPress={() => void camera()} style={styles.secondaryButton}><Text style={styles.secondaryText}>拍照</Text></Pressable>
                <Pressable onPress={() => void pick()} style={styles.primaryButton}><Text style={styles.primaryText}>从相册选择</Text></Pressable>
              </View>
            </View>
          )}
          <View style={styles.captionCard}>
            <Text style={styles.captionLabel}>这一刻我想记住</Text>
            <TextInput
              accessibilityLabel="图片感想"
              multiline
              onChangeText={setCaption}
              placeholder="写下当时的感受，而不是描述画面……"
              placeholderTextColor={colors.faint}
              style={styles.captionInput}
              textAlignVertical="top"
              value={caption}
            />
          </View>
          {saving ? <ActivityIndicator color={colors.accent} /> : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },
  header: { minHeight: 86, paddingHorizontal: 24, paddingBottom: 14, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  cancel: { color: colors.sageText, fontSize: 16, fontWeight: '700' },
  heading: { color: colors.ink, fontSize: 18, fontWeight: '800' },
  save: { color: colors.sageText, fontSize: 16, fontWeight: '800' },
  disabledText: { opacity: 0.3 },
  body: { padding: 20, gap: 18 },
  photos: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, borderRadius: 24, overflow: 'hidden', position: 'relative' },
  hero: { width: '100%', aspectRatio: 4 / 3, backgroundColor: colors.line },
  tile: { width: '49.4%', aspectRatio: 1, flexGrow: 1, backgroundColor: colors.line },
  replaceButton: { position: 'absolute', right: 12, bottom: 12, paddingHorizontal: 13, paddingVertical: 8, borderRadius: 16, backgroundColor: 'rgba(44,52,48,0.72)' },
  replaceText: { color: colors.white, fontWeight: '700' },
  emptyPhoto: { minHeight: 300, padding: 28, borderRadius: 26, alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: colors.sage },
  emptyMark: { color: colors.sageText, fontSize: 38 },
  emptyTitle: { color: colors.ink, fontSize: 21, fontWeight: '800' },
  emptyBody: { color: colors.muted, fontSize: 14, lineHeight: 22, textAlign: 'center' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 10 },
  secondaryButton: { minWidth: 92, padding: 13, borderRadius: 16, alignItems: 'center', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  secondaryText: { color: colors.sageText, fontWeight: '800' },
  primaryButton: { minWidth: 124, padding: 13, borderRadius: 16, alignItems: 'center', backgroundColor: colors.accent },
  primaryText: { color: colors.white, fontWeight: '800' },
  captionCard: { minHeight: 180, padding: 18, borderRadius: 22, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, gap: 10 },
  captionLabel: { color: colors.sageText, fontSize: 13, fontWeight: '800', letterSpacing: 0.5 },
  captionInput: { minHeight: 110, color: colors.ink, fontSize: 17, lineHeight: 26 },
});
