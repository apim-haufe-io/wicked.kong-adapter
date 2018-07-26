'use strict';

export interface SyncStatistics {
    actions: any[],
    failedComparisons: any[],
    err?: any
}

export interface KongCollection<T> {
    total: number,
    data: T[],
    next?: string
}

export interface KongConsumer {
    id?: string,
    created_at?: number,
    username?: string,
    custom_id: string
}

export interface KongProxyListener {
    ssl: boolean,
    ip: string,
    proxy_protocol: boolean,
    port: number,
    http2: boolean
    listener: string
}

export interface KongHttpDirective {
    value: string,
    name: string
}

/**
 * This is a possibly incomplete set of properties which a get to <kong>:8001/ returns.
 */
export interface KongGlobals {
    version: string,
    host: string,
    tagline: string,
    node_id: string,
    lua_version: string,
    plugins: {
        enabled_in_cluster: string[],
        available_on_server: {
            [plugin_name: string]: boolean
        }
    },
    configuration: {
        plugins: string[],
        admin_listen: string[],
        lua_ssl_verify_depth: number,
        trusted_ips: string[],
        prefix: string,
        loaded_plugins: {
            [plugin_name: string]: boolean
        },
        cassandra_username: string,
        admin_ssl_cert_csr_default: string,
        ssl_cert_key: string,
        dns_resolver: object,
        pg_user: string,
        mem_cache_size: string,
        cassandra_data_centers: string[],
        nginx_admin_directives: any,
        custom_plugins: any,
        pg_host: string,
        nginx_acc_logs: string,
        proxy_listen: string[],
        client_ssl_cert_default: string,
        ssl_cert_key_default: string,
        dns_no_sync: boolean,
        db_update_propagation: number,
        nginx_err_logs: string,
        cassandra_port: number,
        dns_order: string[],
        dns_error_ttl: number,
        headers: string[],
        dns_stale_ttl: number,
        nginx_optimizations: boolean,
        database: string,
        pg_database: string,
        nginx_worker_processes: string,
        lua_package_cpath: string,
        admin_acc_logs: string,
        lua_package_path: string,
        nginx_pid: string,
        upstream_keepalive: number,
        cassandra_contact_points: string[],
        client_ssl_cert_csr_default: string,
        proxy_listeners: KongProxyListener[],
        proxy_ssl_enabled: boolean,
        admin_access_log: string,
        pg_password: string,
        enabled_headers: {
            latency_tokens: boolean,
            "X-Kong-Proxy-Latency": boolean,
            Via: boolean,
            server_tokens: boolean,
            Server: boolean,
            "X-Kong-Upstream-Latency": boolean,
            "X-Kong-Upstream-Status": boolean
        },
        cassandra_ssl: boolean,
        ssl_cert_csr_default: string,
        db_resurrect_ttl: number,
        client_max_body_size: string,
        cassandra_consistency: string,
        db_cache_ttl: number,
        admin_error_log: string,
        pg_ssl_verify: boolean,
        dns_not_found_ttl: boolean,
        pg_ssl: boolean,
        client_ssl: boolean,
        db_update_frequency: number,
        cassandra_repl_strategy: string,
        nginx_kong_conf: string,
        cassandra_repl_factor: number,
        nginx_http_directives: KongHttpDirective[],
        error_default_type: string,
        kong_env: string,
        cassandra_schema_consensus_timeout: number,
        dns_hostsfile: string,
        admin_listeners: KongProxyListener[],
        real_ip_header: string,
        ssl_cert: string,
        proxy_access_log: string,
        admin_ssl_cert_key_default: string,
        cassandra_ssl_verify: boolean,
        cassandra_lb_policy: string,
        ssl_cipher_suite: string,
        real_ip_recursive: string,
        proxy_error_log: string,
        client_ssl_cert_key_default: string,
        nginx_daemon: string,
        anonymous_reports: boolean,
        cassandra_timeout: number,
        nginx_proxy_directives: any,
        pg_port: number,
        log_level: string,
        client_body_buffer_size: string,
        ssl_ciphers: string,
        lua_socket_pool_size: number,
        admin_ssl_cert_default: string,
        cassandra_keyspace: string,
        ssl_cert_default: string,
        nginx_conf: string,
        admin_ssl_enabled: boolean
    }
}

export interface KongStatus {
    database: {
        reachable: boolean
    },
    server: {
        connections_writing: number,
        total_requests: number,
        connections_handled: number,
        connections_accepted: number,
        connections_reading: number,
        connections_active: number,
        connections_waiting: number
    }
}
