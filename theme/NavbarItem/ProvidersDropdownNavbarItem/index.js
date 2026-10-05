// Navbar item type `custom-providersDropdown`: the two-level "Providers"
// menu of every StackQL property. Level one is the provider categories,
// each linking to its section of the catalog page on the main site; level
// two is the category's providers, each linking to its microsite.
//
// The catalog comes from the shared plugin in ../../../index.js, which
// fetches https://stackql.io/providers.json when the consuming site builds
// and publishes it as the plugin's global data, so the menu lists whatever
// the main site publishes on the day the site builds. buildNavbar() emits
// the item and the plugin registers this folder as a theme, so no consumer
// site swizzles anything. The main site renders the same menu from its own
// copy of this component (stackql.io: src/theme/NavbarItem); keep the two
// alike.
//
// Desktop: the Infima dropdown markup of theme-classic's
// DropdownNavbarItem/Desktop with a flyout per category that opens on
// hover or keyboard focus (styles.module.css). Mobile: the sidebar's
// collapsible list markup of DropdownNavbarItem/Mobile, one collapsible per
// category, hidden and shown by Infima's menu__list-item--collapsed rule.
// Both use nothing beyond React, Docusaurus core aliases and theme-classic's
// own NavbarNavLink: this folder is vendored, not installed, and must
// bundle under every consumer's dependency set.
//
// Category and provider rows are plain same-tab anchors to their absolute
// targets rather than `to:` links through the shared redirect routes: a
// category row is a deep link to a section of the catalog page, which a
// redirect cannot carry, and forty-odd provider redirect pages per site
// would be noise. Plain anchors also keep the external-link icon off. The
// "Providers" label itself stays a `to:` to the shared /providers redirect.
import React, {useEffect, useRef, useState} from 'react';
import {usePluginData} from '@docusaurus/useGlobalData';
import NavbarNavLink from '@theme/NavbarItem/NavbarNavLink';
import styles from './styles.module.css';

// The shared plugin's name (index.js) and the global-data key it publishes
// the catalog under.
const PLUGIN_NAME = 'stackql-shared';

const cx = (...names) => names.filter(Boolean).join(' ');

function useCategories() {
  const data = usePluginData(PLUGIN_NAME);
  return (data && data.catalog && data.catalog.categories) || [];
}

// ---------------------------------------------------------------- desktop

function DesktopCategory({category}) {
  return (
    <li className={styles.category}>
      <a
        className={cx('dropdown__link', styles.categoryLink)}
        href={category.url}
        target="_self"
        aria-haspopup="true">
        {category.name}
      </a>
      <ul className={styles.submenu} aria-label={category.name}>
        {category.providers.map((provider) => (
          <li key={provider.href}>
            <a className="dropdown__link" href={provider.href} target="_self">
              {provider.name}
            </a>
          </li>
        ))}
      </ul>
    </li>
  );
}

function ProvidersDropdownDesktop({position, className, onClick, ...props}) {
  const categories = useCategories();
  const dropdownRef = useRef(null);
  const [showDropdown, setShowDropdown] = useState(false);
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (!dropdownRef.current || dropdownRef.current.contains(event.target)) {
        return;
      }
      setShowDropdown(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    document.addEventListener('focusin', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
      document.removeEventListener('focusin', handleClickOutside);
    };
  }, [dropdownRef]);
  return (
    <div
      ref={dropdownRef}
      className={cx(
        'navbar__item',
        'dropdown',
        'dropdown--hoverable',
        position === 'right' && 'dropdown--right',
        showDropdown && 'dropdown--show',
      )}>
      <NavbarNavLink
        aria-haspopup="true"
        aria-expanded={showDropdown}
        role="button"
        // # hash makes the <a> focusable when there is no link target
        href={props.to ? undefined : '#'}
        className={cx('navbar__link', className)}
        {...props}
        onClick={props.to ? undefined : (e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setShowDropdown(!showDropdown);
          }
        }}>
        {props.children ?? props.label}
      </NavbarNavLink>
      <ul className={cx('dropdown__menu', styles.menu)}>
        {categories.map((category) => (
          <DesktopCategory key={category.id} category={category} />
        ))}
      </ul>
    </div>
  );
}

// ----------------------------------------------------------------- mobile

// One collapsible row of the mobile sidebar. With `to`, the label is a
// link that navigates and toggles (as a Docusaurus mobile dropdown does);
// without it, the label only toggles.
function MobileSublist({label, to, children}) {
  const [collapsed, setCollapsed] = useState(true);
  const toggle = () => setCollapsed((value) => !value);
  const href = to ? undefined : '#';
  return (
    <li
      className={cx('menu__list-item', collapsed && 'menu__list-item--collapsed')}>
      <div className="menu__list-item-collapsible">
        <NavbarNavLink
          role="button"
          className={cx('menu__link menu__link--sublist', styles.mobileSublistLink)}
          href={href}
          to={to}
          label={label}
          onClick={(e) => {
            if (href === '#') {
              e.preventDefault();
            }
            toggle();
          }}
        />
        <button
          aria-label={collapsed ? 'Expand the dropdown' : 'Collapse the dropdown'}
          aria-expanded={!collapsed}
          type="button"
          className="clean-btn menu__caret"
          onClick={(e) => {
            e.preventDefault();
            toggle();
          }}
        />
      </div>
      <ul className="menu__list">{children}</ul>
    </li>
  );
}

function ProvidersDropdownMobile({position, className, onClick, ...props}) {
  const categories = useCategories();
  return (
    <MobileSublist label={props.label} to={props.to}>
      {categories.map((category) => (
        <MobileSublist key={category.id} label={category.name}>
          {category.providers.map((provider) => (
            <li key={provider.href} className="menu__list-item">
              <a
                className="menu__link"
                href={provider.href}
                target="_self"
                onClick={onClick}>
                {provider.name}
              </a>
            </li>
          ))}
        </MobileSublist>
      ))}
    </MobileSublist>
  );
}

export default function ProvidersDropdownNavbarItem({mobile = false, ...props}) {
  const Comp = mobile ? ProvidersDropdownMobile : ProvidersDropdownDesktop;
  return <Comp {...props} />;
}
