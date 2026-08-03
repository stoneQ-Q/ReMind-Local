import { StatusBar } from 'expo-status-bar';
import { SQLiteProvider } from 'expo-sqlite';
import { Suspense } from 'react';
import {
  ActivityIndicator,
  Platform,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ReMindApp } from './src/ReMindApp';
import { migrateDatabase } from './src/database';
import { REMIND_DATABASE_NAME } from './src/persistence-contract';
import { colors } from './src/theme';

function AppLoading() {
  return (
    <View style={styles.loading}>
      <View style={styles.loadingMark}>
        <Text style={styles.loadingMarkText}>R</Text>
      </View>
      <ActivityIndicator color={colors.ink} />
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <Suspense fallback={<AppLoading />}>
        <SQLiteProvider
          databaseName={REMIND_DATABASE_NAME}
          onInit={migrateDatabase}
          useSuspense
        >
          <ReMindApp />
        </SQLiteProvider>
      </Suspense>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
    backgroundColor: colors.paper,
  },
  loadingMark: {
    width: 56,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: colors.ink,
    borderRadius: 17,
    backgroundColor: colors.sage,
    transform: [{ rotate: '-2deg' }],
  },
  loadingMarkText: {
    color: colors.sageText,
    fontFamily: Platform.select({ ios: 'Songti SC', android: 'serif' }),
    fontSize: 24,
    fontWeight: '700',
  },
});
