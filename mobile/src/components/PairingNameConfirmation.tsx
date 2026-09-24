import { useState, type JSX } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { hostPlatformDisplayName } from '../../../src/shared/host-platform-label'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export function PairingNameConfirmation(props: {
  machineName: string | null
  hostPlatform: NodeJS.Platform | null
  initialName: string
  saving: boolean
  errorMessage: string | null
  onConfirm: (name: string) => void
  onCancel: () => void
}): JSX.Element {
  const [name, setName] = useState(props.initialName)
  const machineLabel = props.machineName ?? 'this desktop'
  const platform = hostPlatformDisplayName(props.hostPlatform)
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Connected to {machineLabel}</Text>
      {platform ? <Text style={styles.platform}>{platform}</Text> : null}
      <Text style={styles.subtitle}>
        Choose the name for this desktop on your phone. This label is personal to this device.
      </Text>
      <Text style={styles.label}>Phone label</Text>
      <TextInput
        accessibilityLabel="Phone label"
        autoCapitalize="words"
        autoCorrect={false}
        editable={!props.saving}
        maxLength={255}
        onChangeText={setName}
        placeholder={props.initialName}
        style={styles.input}
        value={name}
      />
      {props.errorMessage ? <Text style={styles.error}>{props.errorMessage}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save host label"
        disabled={props.saving}
        onPress={() => props.onConfirm(name)}
        style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
      >
        {props.saving ? <ActivityIndicator color={colors.bgBase} /> : null}
        <Text style={styles.primaryButtonText}>
          {props.saving ? 'Saving…' : 'Save and continue'}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel pairing"
        disabled={props.saving}
        onPress={props.onCancel}
        style={styles.secondaryButton}
      >
        <Text style={styles.secondaryButtonText}>Cancel</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { width: '100%', maxWidth: 420, alignSelf: 'center' },
  title: {
    color: colors.textPrimary,
    fontSize: typography.titleSize,
    fontWeight: '600',
    textAlign: 'center'
  },
  platform: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    marginTop: spacing.xs,
    textAlign: 'center'
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    lineHeight: 20,
    marginBottom: spacing.lg,
    marginTop: spacing.sm,
    textAlign: 'center'
  },
  label: { color: colors.textSecondary, fontSize: typography.metaSize, marginBottom: spacing.xs },
  input: {
    borderColor: colors.borderSubtle,
    borderRadius: radii.input,
    borderWidth: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  error: {
    color: colors.statusRed,
    fontSize: typography.bodySize,
    marginTop: spacing.sm,
    textAlign: 'center'
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: colors.textPrimary,
    borderRadius: radii.button,
    flexDirection: 'row',
    gap: spacing.xs,
    justifyContent: 'center',
    marginTop: spacing.lg,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm + 2
  },
  primaryButtonText: { color: colors.bgBase, fontSize: typography.bodySize, fontWeight: '600' },
  secondaryButton: { alignItems: 'center', padding: spacing.md },
  secondaryButtonText: { color: colors.textSecondary, fontSize: typography.bodySize },
  pressed: { opacity: 0.8 }
})
