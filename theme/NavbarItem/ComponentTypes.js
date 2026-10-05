// Registers the shared navbar item types on top of theme-classic's.
//
// This folder is a Docusaurus theme: the shared plugin in ../../index.js
// returns it from getThemePath(), and because that plugin sits after the
// classic preset in every consumer's plugin order, this file shadows
// theme-classic's registry and `@theme-init/...` below resolves to the
// registry it shadows. A consumer site that swizzles
// NavbarItem/ComponentTypes itself reaches this one as `@theme-original/...`
// and should spread it, or the shared types disappear.
import ComponentTypes from '@theme-init/NavbarItem/ComponentTypes';
import ProvidersDropdownNavbarItem from './ProvidersDropdownNavbarItem';

export default {
  ...ComponentTypes,
  'custom-providersDropdown': ProvidersDropdownNavbarItem,
};
