package com.office.snacks.config;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.*;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.core.userdetails.*;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
public class SecurityConfig {
 @Bean PasswordEncoder passwordEncoder(){return new BCryptPasswordEncoder();}
 @Bean UserDetailsService userDetailsService(PasswordEncoder encoder,@Value("${app.admin.username}") String admin,@Value("${app.admin.password}") String adminPass,@Value("${app.employee.username}") String employee,@Value("${app.employee.password}") String employeePass){return new InMemoryUserDetailsManager(User.withUsername(admin).password(encoder.encode(adminPass)).roles("ADMIN").build(),User.withUsername(employee).password(encoder.encode(employeePass)).roles("EMPLOYEE").build());}
 @Bean SecurityFilterChain security(HttpSecurity http)throws Exception{return http.csrf(csrf->csrf.disable()).cors(Customizer.withDefaults()).authorizeHttpRequests(auth->auth.requestMatchers(org.springframework.http.HttpMethod.GET,"/api/employees/**","/api/snacks/**").hasAnyRole("ADMIN","EMPLOYEE").requestMatchers("/api/employees/**","/api/snacks/**","/api/reports/**","/api/dashboard/**").hasRole("ADMIN").requestMatchers("/api/records/**").hasAnyRole("ADMIN","EMPLOYEE").anyRequest().authenticated()).httpBasic(Customizer.withDefaults()).build();}
}
